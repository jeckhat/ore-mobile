import { LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js"
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";

import { Boost, BoostConfig, CustomError, Numeric, Proof, Stake } from "@models"
import { getBoost, getBoostConfig, getBoostDecimals, getBoostProof, getStake } from "./boost"
import { BOOST_ID, BOOSTLIST, KAMINO_API, METEORA_API, ORE_MINT, PROGRAM_ID, SOL_MINT, TREASURY } from "@constants";
import { getBalance } from "@services/solana";
import { getConnection, getWalletAddress } from "@providers";
import { bigIntToNumber } from "@helpers";
import { store } from "@store/index";
import { boostActions } from "@store/actions";

export function calculateClaimableYield(boost: Boost, boostProof: Proof, stake: Stake, boostConfig: BoostConfig) {
    let rewards = BigInt(stake.rewards ?? 0);
    let configRewardsFactor = boostConfig.rewardsFactor
    let boostRewardsFactor = boost.rewardsFactor

    if (!configRewardsFactor) {
        configRewardsFactor = new Numeric(BigInt(0))
    }

    if (!boostRewardsFactor) {
        boostRewardsFactor = new Numeric(BigInt(0))
    }

    if (!boost.totalDeposits) {
        return rewards
    }

    if (!boost.lastRewardsFactor) {
        return rewards
    }

    if (!stake.lastRewardsFactor) {
        return rewards
    }

    if (boostProof.balance && boostProof.balance > 0 && boostConfig.totalWeight) {
        const extraFactor = Numeric.fromFraction(boostProof.balance, boostConfig.totalWeight)
        configRewardsFactor = configRewardsFactor.add(extraFactor)
    }

    if(configRewardsFactor.gt(boost.lastRewardsFactor)) {
        const accumulatedRewards = configRewardsFactor.sub(boost.lastRewardsFactor)
        const boostRewards = accumulatedRewards.mul(Numeric.fromU64(boost.weight ?? 0))
        const delta = boostRewards.div(Numeric.fromU64(boost.totalDeposits ?? 1))
        boostRewardsFactor = boostRewardsFactor.add(delta)
    }

    if(boostRewardsFactor.gt(stake.lastRewardsFactor)) {
        let accumulatedRewards = boostRewardsFactor.sub(stake.lastRewardsFactor)
        let personalRewards = accumulatedRewards.mul(Numeric.fromU64(stake?.balance ?? 0))
        rewards = rewards + personalRewards.toU64()
    }

    return rewards;
}

export async function getStakeORE(mintAddress: string, boostAddress?: string) {
    const walletAddress = getWalletAddress()

    if (!walletAddress) {
        throw new CustomError("Wallet Address is undefined", 500)
    }

    const stakerPublicKey = new PublicKey(walletAddress)
    const mintPublicKey = new PublicKey(mintAddress)

    const { boost, boostPublicKey } = await getBoost(mintPublicKey, boostAddress)

    store.dispatch(boostActions.updateBoostRedux({
        boostAddress: boostPublicKey.toBase58(),
        boost: boost
    }))

    const { stake, stakePublicKey } = await getStake(stakerPublicKey, boostPublicKey)

    store.dispatch(boostActions.updateStakeRedux({
        boostAddress: boostPublicKey.toBase58(),
        stake: stake,
        stakeAddress: stakePublicKey.toBase58()
    }))

    const decimals = await getBoostDecimals(mintPublicKey, boostPublicKey)

    store.dispatch(boostActions.updateDecimals({
        boostAddress: boostPublicKey.toBase58(),
        decimals: decimals,
    }))

    const { boostConfig, boostConfigPublicKey } = await getBoostConfig()

    store.dispatch(boostActions.updateConfigRedux({
        boostAddress: boostPublicKey.toBase58(),
        boostConfig: boostConfig,
        boostConfigAddress: boostConfigPublicKey.toBase58()
    }))

    const { boostProof, boostProofPublicKey } = await getBoostProof(boostConfigPublicKey)

    store.dispatch(boostActions.updateProofRedux({
        boostAddress: boostPublicKey.toBase58(),
        boostProof: boostProof,
        boostProofAddress: boostProofPublicKey.toBase58()
    }))

    const rewards = calculateClaimableYield(boost, boostProof, stake, boostConfig)

    store.dispatch(boostActions.updateRewards({
        boostAddress: boostPublicKey.toBase58(),
        rewards: bigIntToNumber(rewards / 10n ** 11n)
    }))

    return {
        mintPublicKey: mintPublicKey,
        decimals: decimals,
        boost: boost,
        boostPublicKey: boostPublicKey,
        stake: stake,
        stakePublicKey: stakePublicKey,
        boostProof: boostProof,
        boostProofPublicKey: boostProofPublicKey,
        boostConfig: boostConfig,
        boostConfigPublicKey: boostConfigPublicKey,
        rewards: bigIntToNumber(rewards),
    }
}

export async function getLiquidityPair(lpId: string, defi: string, boostAddress: string) {
    const connection = getConnection()

    const mintAddress = BOOSTLIST[boostAddress].lpMint
    
    if(defi === 'kamino') {
        const response = await fetch(`${KAMINO_API}${lpId}/metrics/?env=mainnet-beta&status=LIVE`, {
            method: 'GET'
        })
        const resData = await response.json()

        const tokenA = resData.tokenAMint
        const tokenB = resData.tokenBMint
        const balanceA = resData?.vaultBalances.tokenA.total
        const balanceB = resData?.vaultBalances.tokenB.total
        const totalValueUsd = resData.totalValueLocked

        const lpMintSupply = await connection.getTokenSupply(new PublicKey(mintAddress))
        const shares = parseFloat(lpMintSupply.value.amount)

        const { stake, decimals } = await getStakeORE(mintAddress, boostAddress)
        const stakeShare = (stake.balance ?? 0) / shares 

        const stakeAmountA = parseFloat(balanceA) * stakeShare
        const stakeAmountB = parseFloat(balanceB) * stakeShare
        return {
            stakeBalance: (stake.balance ?? 0) / Math.pow(10, decimals),
            stakeAmountORE: tokenA === ORE_MINT? stakeAmountA : stakeAmountB,
            stakeAmountPair: tokenB === ORE_MINT? stakeAmountA : stakeAmountB,
            LPBalanceORE: tokenA === ORE_MINT? parseFloat(balanceA) : parseFloat(balanceB),
            LPBalancePair: tokenB === ORE_MINT? parseFloat(balanceA) : parseFloat(balanceB),
            totalValueUsd: totalValueUsd,
            shares: shares,
        }

    } else {
        const response = await fetch(`${METEORA_API}${lpId}`, {
            method: 'GET'
        })
        const resData = await response.json()
        const tokenA = resData?.[0]?.pool_token_mints[0]
        const tokenB = resData?.[0]?.pool_token_mints[1]
        const balanceA = resData?.[0]?.pool_token_amounts[0]
        const balanceB = resData?.[0]?.pool_token_amounts[1]
        const totalValueUsd = resData?.[0]?.pool_tvl

        const lpMintSupply = await connection.getTokenSupply(new PublicKey(mintAddress))
        const shares = parseFloat(lpMintSupply.value.amount)

        const { stake, decimals } = await getStakeORE(mintAddress, boostAddress)
        const stakeShare = (stake.balance ?? 0) / shares 

        const stakeAmountA = parseFloat(balanceA) * stakeShare
        const stakeAmountB = parseFloat(balanceB) * stakeShare
        return {
            stakeBalance: (stake.balance ?? 0) / Math.pow(10, decimals),
            stakeAmountORE: tokenA === ORE_MINT? stakeAmountA : stakeAmountB,
            stakeAmountPair: tokenB === ORE_MINT? stakeAmountA : stakeAmountB,
            LPBalanceORE: tokenA === ORE_MINT? parseFloat(balanceA) : parseFloat(balanceB),
            LPBalancePair: tokenB === ORE_MINT? parseFloat(balanceA) : parseFloat(balanceB),
            totalValueUsd: totalValueUsd,
            shares: shares,
        }
    }
}

export async function claimStakeOREInstruction(mintAddress: string, boostAddress: string) {
    const connection = getConnection()
    const walletAddress = getWalletAddress()

    if (!connection) {
        throw new CustomError("Rpc Connection is undefined", 500)
    }

    if (!walletAddress) {
        throw new CustomError("Wallet Address is undefined", 500)
    }

    const staker = new PublicKey(walletAddress)

    const transaction = new Transaction();
    const accountORE = getAssociatedTokenAddressSync(
        new PublicKey(ORE_MINT),
        staker
    );
    const account = await connection.getAccountInfo(accountORE)

    if (!account) {
        const createTokenAccountIx = createAssociatedTokenAccountInstruction(
            staker,
            accountORE,
            staker,
            new PublicKey(ORE_MINT),
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        transaction.add(createTokenAccountIx)
    }

    const {
        boost,
        stake,
        boostProof,
        boostPublicKey,
        stakePublicKey,
        boostProofPublicKey,
        boostConfig
    } = await getStakeORE(mintAddress, boostAddress)

    const rewards = calculateClaimableYield(boost, boostProof, stake, boostConfig)
    const amountBuffer = Buffer.alloc(8)
    amountBuffer.writeBigUInt64LE(BigInt(rewards))
    
    const beneficiaryPublicKey = getAssociatedTokenAddressSync(
        new PublicKey(ORE_MINT),
        staker
    );

    const boostRewardsPublicKey = getAssociatedTokenAddressSync(
        new PublicKey(ORE_MINT),
        boostPublicKey,
        true
    );

    const treasuryAddress = PublicKey.findProgramAddressSync(
        [...[TREASURY]],
        new PublicKey(PROGRAM_ID)
    )?.[0]

    const treasuryTokenAddress = PublicKey.findProgramAddressSync(
        [
            ...[treasuryAddress.toBytes()],
            ...[new PublicKey(TOKEN_PROGRAM_ID).toBytes()],
            ...[new PublicKey(ORE_MINT).toBytes()]
        ],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
    )?.[0]

    const instruction = new TransactionInstruction({
        programId: new PublicKey(BOOST_ID),
        keys: [
            { pubkey: staker, isSigner: true, isWritable: true },
            { pubkey: beneficiaryPublicKey, isSigner: false, isWritable: true },
            { pubkey: boostPublicKey, isSigner: false, isWritable: true },
            { pubkey: boostProofPublicKey, isSigner: false, isWritable: true },
            { pubkey: boostRewardsPublicKey, isSigner: false, isWritable: true },
            { pubkey: stakePublicKey, isSigner: false, isWritable: true },
            { pubkey: treasuryAddress, isSigner: false, isWritable: false },
            { pubkey: treasuryTokenAddress, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }
        ],
        data: Buffer.concat([Buffer.from([0]), amountBuffer])
    })

    transaction.add(instruction)

    const { blockhash } = await connection.getLatestBlockhash()
    transaction.recentBlockhash = blockhash
    transaction.feePayer = staker
    const feeCalculator = await connection.getFeeForMessage(transaction.compileMessage())
    if (!feeCalculator.value) {
        throw new CustomError("Fee is empty", 500)
    }
    const estimatedFee = feeCalculator.value / LAMPORTS_PER_SOL

    const balanceSol = await getBalance(walletAddress, SOL_MINT)

    if (balanceSol < estimatedFee) {
        throw new CustomError(
            `Insufficient balance! Minimum of ${estimatedFee.toFixed(6)} SOL is required, while the current balance is only ${balanceSol} SOL.`,
            500
        );
    } 

    return { transaction, rewards: rewards / (10n ** 11n), estimatedFee, connection };
}