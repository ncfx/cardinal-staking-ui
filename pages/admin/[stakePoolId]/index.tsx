import { tryGetAccount } from '@cardinal/common'
import { executeTransaction } from '@cardinal/staking'
import { getRewardDistributor } from '@cardinal/staking/dist/cjs/programs/rewardDistributor/accounts'
import { findRewardDistributorId } from '@cardinal/staking/dist/cjs/programs/rewardDistributor/pda'
import {
  withUpdateRewardDistributor,
  withUpdateRewardEntry,
} from '@cardinal/staking/dist/cjs/programs/rewardDistributor/transaction'
import {
  withAuthorizeStakeEntry,
  withUpdateStakePool,
} from '@cardinal/staking/dist/cjs/programs/stakePool/transaction'
import { Wallet } from '@metaplex/js'
import { BN } from '@project-serum/anchor'
import { useWallet } from '@solana/wallet-adapter-react'
import { PublicKey, SendTransactionError, Transaction } from '@solana/web3.js'
import { Footer } from 'common/Footer'
import { Header } from 'common/Header'
import { notify } from 'common/Notification'
import { ShortPubKeyUrl } from 'common/Pubkeys'
import { useStakePoolData } from 'hooks/useStakePoolData'
import Head from 'next/head'
import { useEnvironmentCtx } from 'providers/EnvironmentProvider'
import { useState } from 'react'
import { TailSpin } from 'react-loader-spinner'
import { parseMintNaturalAmountFromDecimal } from 'common/units'
import { CreationForm, StakePoolForm } from 'components/StakePoolForm'
import { useRewardDistributorData } from 'hooks/useRewardDistributorData'
import { tryPublicKey } from 'common/utils'
import { findStakeEntryIdFromMint } from '@cardinal/staking/dist/cjs/programs/stakePool/utils'
import * as Yup from 'yup'
import { useFormik } from 'formik'
import { handleError } from 'api/api'

const publicKeyValidationTest = (value: string | undefined): boolean => {
  return tryPublicKey(value) ? true : false
}

const creationFormSchema = Yup.object({
  multipliers: Yup.array().of(
    Yup.string().test(
      'is-public-key',
      'Invalid collection address',
      publicKeyValidationTest
    )
  ),
  multiplierMints: Yup.array().of(
    Yup.string().test(
      'is-public-key',
      'Invalid collection address',
      publicKeyValidationTest
    )
  ),
})
export type MultipliersForm = Yup.InferType<typeof creationFormSchema>

function AdminStakePool() {
  const wallet = useWallet()
  const { connection, environment } = useEnvironmentCtx()
  const stakePool = useStakePoolData()
  const rewardDistributor = useRewardDistributorData()
  const [mintsToAuthorize, setMintsToAuthorize] = useState<string>('')
  const [defaultMultiplier, setDefaultMultiplier] = useState<string>('0')
  const [multiplierDecimals, setMultiplierDecimals] = useState<string>('0')
  const [loadingHandleAuthorizeMints, setLoadingHandleAuthorizeMints] =
    useState<boolean>(false)
  const [loadingHandleMultipliers, setLoadingHandleMultipliers] =
    useState<boolean>(false)

  const initialValues: MultipliersForm = {
    multipliers: [''],
    multiplierMints: [''],
  }
  const formState = useFormik({
    initialValues,
    onSubmit: (values) => {},
    validationSchema: creationFormSchema,
  })
  const { values, errors, setFieldValue, handleChange } = formState

  const handleMutliplier = async () => {
    setLoadingHandleMultipliers(true)
    if (!wallet?.connected) {
      throw 'Wallet not connected'
    }
    try {
      if (!stakePool.data?.pubkey) {
        throw 'Stake pool pubkey not found'
      }

      if (!values.multiplierMints) {
        throw 'Invalid multiplier mints'
      }
      if (!values.multipliers) {
        throw 'Invalid multipliers'
      }

      if (values.multipliers.length !== values.multiplierMints.length) {
        notify({
          message: `Error: Multiplier and mints aren't 1:1`,
          type: 'error',
        })
        return
      }

      if (values.multiplierMints.toString() === [''].toString())
        values.multiplierMints = []
      if (values.multipliers.toString() === [''].toString())
        values.multipliers = []
      let pubKeysToSetMultiplier = []
      for (let i = 0; i < values.multiplierMints.length; i++) {
        if (values.multiplierMints[i] !== '' && values.multipliers[i] !== '') {
          pubKeysToSetMultiplier.push(new PublicKey(values.multiplierMints[i]!))
        } else {
          notify({
            message: `Error: Invalid multiplier mint "${values.multiplierMints[
              i
            ]!}" or multiplier "${values.multipliers[i]!}"`,
          })
          return
        }
      }

      if (pubKeysToSetMultiplier.length === 0) {
        notify({ message: `Info: No mints inserted` })
      }
      if (values.multipliers.length === 0) {
        notify({ message: `Info: No multiplier inserted` })
      }

      const [rewardDistributorId] = await findRewardDistributorId(
        stakePool.data.pubkey
      )
      const rewardDistributor = await tryGetAccount(() =>
        getRewardDistributor(connection, rewardDistributorId)
      )
      if (!rewardDistributor) {
        throw 'Reward Distributor for pool not found'
      }

      if (
        rewardDistributor.parsed.defaultMultiplier.toString() !==
          defaultMultiplier &&
        rewardDistributor.parsed.multiplierDecimals.toString() !==
          multiplierDecimals
      ) {
        const tx = await withUpdateRewardDistributor(
          new Transaction(),
          connection,
          wallet as Wallet,
          {
            stakePoolId: stakePool.data.pubkey,
            defaultMultiplier: new BN(defaultMultiplier),
            multiplierDecimals: Number(multiplierDecimals),
          }
        )
        console.log(tx)
        await executeTransaction(connection, wallet as Wallet, tx, {
          silent: false,
          signers: [],
        })
        notify({
          message: `Successfully updated defaultMultiplier and multiplierDecimals`,
          type: 'success',
        })
      }

      for (let i = 0; i < pubKeysToSetMultiplier.length; i++) {
        let mint = pubKeysToSetMultiplier[i]!
        const [stakeEntryId] = await findStakeEntryIdFromMint(
          connection,
          wallet.publicKey!,
          stakePool.data.pubkey,
          mint
        )
        const transaction = await withUpdateRewardEntry(
          new Transaction(),
          connection,
          wallet as Wallet,
          {
            stakePoolId: stakePool.data.pubkey,
            rewardDistributorId: rewardDistributor.pubkey,
            stakeEntryId: stakeEntryId,
            multiplier: new BN(values.multipliers[i]!),
          }
        )
        await executeTransaction(connection, wallet as Wallet, transaction, {
          silent: false,
          signers: [],
        })
        notify({
          message: `Successfully set multiplier ${i + 1}/${
            pubKeysToSetMultiplier.length
          }`,
          type: 'success',
        })
      }
    } catch (e) {
      const parsedError = handleError(e, 'Error setting multiplier')
      notify({
        message: parsedError || String(e),
        type: 'error',
      })
    } finally {
      setLoadingHandleMultipliers(false)
    }
  }

  const handleAuthorizeMints = async () => {
    setLoadingHandleAuthorizeMints(true)
    try {
      if (!wallet?.connected) {
        throw 'Wallet not connected'
      }
      if (!stakePool.data?.pubkey) {
        throw 'Stake pool pubkey not found'
      }
      const authorizePublicKeys =
        mintsToAuthorize.length > 0
          ? mintsToAuthorize
              .split(',')
              .map((address) => new PublicKey(address.trim()))
          : []

      if (authorizePublicKeys.length === 0) {
        notify({ message: `Error: No mints inserted` })
      }
      for (let i = 0; i < authorizePublicKeys.length; i++) {
        let mint = authorizePublicKeys[i]!
        const transaction = await withAuthorizeStakeEntry(
          new Transaction(),
          connection,
          wallet as Wallet,
          {
            stakePoolId: stakePool.data.pubkey,
            originalMintId: mint,
          }
        )
        await executeTransaction(connection, wallet as Wallet, transaction, {
          silent: false,
          signers: [],
        })
        notify({
          message: `Successfully authorized ${i + 1}/${
            authorizePublicKeys.length
          }`,
          type: 'success',
        })
      }
    } catch (e) {
      notify({
        message: handleError(e, 'Error authorizing mint'),
        type: 'error',
      })
    } finally {
      setLoadingHandleAuthorizeMints(false)
    }
  }

  const handleUpdate = async (values: CreationForm) => {
    if (!wallet?.connected) {
      notify({
        message: 'Wallet not connected',
        type: 'error',
      })
      return
    }
    if (
      wallet.publicKey?.toString() !==
      stakePool.data?.parsed.authority.toString()
    ) {
      notify({
        message: 'You are not the pool authority.',
        type: 'error',
      })
      return
    }
    try {
      if (!stakePool.data?.pubkey) {
        throw 'Stake pool pubkey not found'
      }

      const collectionPublicKeys = values.requireCollections
        .map((c) => tryPublicKey(c))
        .filter((c) => c) as PublicKey[]
      const creatorPublicKeys = values.requireCreators
        .map((c) => tryPublicKey(c))
        .filter((c) => c) as PublicKey[]

      const stakePoolParams = {
        stakePoolId: stakePool.data.pubkey,
        requiresCollections: collectionPublicKeys,
        requiresCreators: creatorPublicKeys,
        requiresAuthorization: values.requiresAuthorization,
        overlayText: values.overlayText,
        cooldownSeconds: values.cooldownPeriodSeconds,
        minStakeSeconds: values.minStakeSeconds,
      }

      const [transaction] = await withUpdateStakePool(
        new Transaction(),
        connection,
        wallet as Wallet,
        stakePoolParams
      )

      const [rewardDistributorId] = await findRewardDistributorId(
        stakePool.data.pubkey
      )
      const rewardDistributor = await tryGetAccount(() =>
        getRewardDistributor(connection, rewardDistributorId)
      )

      await executeTransaction(connection, wallet as Wallet, transaction, {
        silent: false,
        signers: [],
      })
      notify({
        message:
          'Successfully updated stake pool with ID: ' +
          stakePool.data.pubkey.toString(),
        type: 'success',
      })

      await setTimeout(() => stakePool.refresh(true), 1000)
    } catch (e) {
      notify({
        message: handleError(e, 'Error updating stake pool'),
        type: 'error',
      })
    }
  }
  return (
    <div>
      <Head>
        <title>Cardinal Staking UI</title>
        <meta name="description" content="Generated by Cardinal Staking UI" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <Header />
      <div className="container mx-auto w-full bg-[#1a1b20]">
        <div className="my-2 h-full min-h-[55vh] rounded-md bg-white bg-opacity-5 p-10 text-gray-200">
          {!stakePool.loaded || !rewardDistributor.loaded ? (
            <div className="h-[40vh] w-full animate-pulse rounded-md bg-white bg-opacity-10"></div>
          ) : stakePool.data ? (
            <div className="grid h-full grid-cols-2 gap-4 ">
              <div>
                <p className="text-lg font-bold">Update Staking Pool</p>
                <p className="mt-1 mb-2 text-sm">
                  All parameters for staking pool are optional. If a field is
                  left
                  <b> empty</b>, it will remain unchanged
                </p>
                <StakePoolForm
                  type="update"
                  handleSubmit={handleUpdate}
                  stakePoolData={stakePool.data}
                  rewardDistributorData={rewardDistributor.data}
                />
              </div>
              <div>
                <p className="text-lg font-bold">Current Staking Pool</p>
                <p className="mt-1 mb-5 text-sm">
                  The parameters currently in place for the stake pool
                </p>
                {stakePool.loaded ? (
                  <>
                    <span className="flex w-full flex-wrap md:mb-0">
                      <label className="inline-block text-sm font-bold uppercase tracking-wide text-gray-200">
                        Overlay Text:
                      </label>
                      <label className="inline-block pl-2">
                        {stakePool.data?.parsed.overlayText || '[None]'}
                      </label>
                    </span>
                    <span className="mt-3 flex w-full flex-wrap md:mb-0">
                      <label className="inline-block text-sm font-bold uppercase tracking-wide text-gray-200">
                        Collection Addresses:
                      </label>
                      <label className="inline-block pl-2">
                        {stakePool.data?.parsed.requiresCollections &&
                        stakePool.data?.parsed.requiresCollections.length !== 0
                          ? stakePool.data?.parsed.requiresCollections.map(
                              (collection) => (
                                <ShortPubKeyUrl
                                  pubkey={collection}
                                  cluster={environment.label}
                                  className="pr-2 text-sm text-white"
                                />
                              )
                            )
                          : '[None]'}
                      </label>
                    </span>
                    <span className="mt-3 flex w-full flex-wrap md:mb-0">
                      <label className="inline-block text-sm font-bold uppercase tracking-wide text-gray-200">
                        Creator Addresses:
                      </label>
                      <label className="inline-block pl-2">
                        {stakePool.data?.parsed.requiresCreators &&
                        stakePool.data?.parsed.requiresCreators.length !== 0
                          ? stakePool.data?.parsed.requiresCreators.map(
                              (creator) => (
                                <ShortPubKeyUrl
                                  pubkey={creator}
                                  cluster={environment.label}
                                  className="pr-2 text-sm text-white"
                                />
                              )
                            )
                          : '[None]'}
                      </label>
                    </span>
                    <span className="mt-3 flex w-full flex-wrap md:mb-0">
                      <label className="inline-block text-sm font-bold uppercase tracking-wide text-gray-200">
                        Requires Authorization:{' '}
                        {stakePool.data?.parsed.requiresAuthorization.toString() ||
                          '[None]'}
                      </label>
                    </span>
                    <span className="mt-3 flex w-full flex-wrap md:mb-0">
                      <label className="inline-block text-sm font-bold uppercase tracking-wide text-gray-200">
                        Cooldown Period Seconds:{' '}
                        {stakePool.data?.parsed.cooldownSeconds || '[None]'}
                      </label>
                    </span>
                    <span className="mt-3 flex w-full flex-wrap md:mb-0">
                      <label className="inline-block text-sm font-bold uppercase tracking-wide text-gray-200">
                        Minimum Stake Seconds:{' '}
                        {stakePool.data?.parsed.minStakeSeconds || '[None]'}
                      </label>
                    </span>
                    {rewardDistributor.data && (
                      <>
                        <span className="mt-3 flex w-full flex-wrap md:mb-0">
                          <label className="inline-block text-sm font-bold uppercase tracking-wide text-gray-200">
                            Default Multiplier:{' '}
                            {rewardDistributor.data.parsed.defaultMultiplier.toNumber() ||
                              '[None]'}
                          </label>
                        </span>
                        <span className="mt-3 flex w-full flex-wrap md:mb-0">
                          <label className="inline-block text-sm font-bold uppercase tracking-wide text-gray-200">
                            Multiplier Decimals:{' '}
                            {rewardDistributor.data.parsed.multiplierDecimals ||
                              '[None]'}
                          </label>
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <div className="relative flex h-8 w-full items-center justify-center">
                    <span className="text-gray-500"></span>
                    <div className="absolute w-full animate-pulse items-center justify-center rounded-lg bg-white bg-opacity-10 p-5"></div>
                  </div>
                )}
                {rewardDistributor.data && (
                  <div className="mt-10">
                    <label
                      className="mb-2 block text-xs font-bold uppercase tracking-wide text-gray-200"
                      htmlFor="require-authorization"
                    >
                      Set multiplier for given mints
                    </label>
                    <p className="text-sm italic text-gray-300">
                      Set the stake multiplier for given mints.
                      <br />
                      For a 1x multiplier, enter value{' '}
                      {10 ** rewardDistributor.data.parsed.multiplierDecimals},
                      for a 2x multiplier enter value{' '}
                      {2 *
                        10 **
                          rewardDistributor.data.parsed.multiplierDecimals}{' '}
                      ...
                    </p>
                    <p className="text-sm italic text-gray-300">
                      For decimal multipliers, work with the reward
                      distributor's <b>multiplierDecimals</b>. If you set
                      multiplierDecimals = 1, then for 1.5x multiplier, enter
                      value 15 so that value/10**multiplierDecimals = 15/10^1 =
                      1.5
                    </p>
                    <p className="text-sm italic text-gray-300">
                      <b>Note</b> that for 1.5x, you could set
                      multiplierDecimals = 2 and enter value 150, or
                      multiplierDecimals = 3 and enter value 1500 ...
                    </p>
                    <span className="my-5 flex flex-row gap-5">
                      <>
                        <p>Multiplier Decimals:</p>
                        <input
                          className="w-1/5 appearance-none flex-col rounded border border-gray-500 bg-gray-700 py-1 px-3 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none"
                          type="text"
                          placeholder={'0'}
                          defaultValue={
                            rewardDistributor.data.parsed.multiplierDecimals
                          }
                          onChange={(e) => {
                            const value = Number(e.target.value)
                            if (
                              !value &&
                              e.target.value.length != 0 &&
                              value !== 0
                            ) {
                              notify({
                                message: `Invalid multiplier decimals`,
                                type: 'error',
                              })
                            }
                            setMultiplierDecimals(e.target.value)
                          }}
                        />
                      </>
                      <>
                        <p>Default Multiplier:</p>
                        <input
                          className="w-1/5 appearance-none flex-col rounded border border-gray-500 bg-gray-700 py-1 px-3 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none"
                          type="text"
                          placeholder={'1'}
                          defaultValue={rewardDistributor.data.parsed.defaultMultiplier.toNumber()}
                          onChange={(e) => {
                            const value = Number(e.target.value)
                            if (
                              !value &&
                              e.target.value.length != 0 &&
                              value !== 0
                            ) {
                              notify({
                                message: `Invalid default multiplier`,
                                type: 'error',
                              })
                            }
                            setDefaultMultiplier(e.target.value)
                          }}
                        />
                      </>
                    </span>
                    <span className="flex flex-row gap-5">
                      <input
                        className="mb-3 w-1/6 appearance-none flex-col rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none"
                        type="text"
                        placeholder={'0'}
                        onChange={(e) => {
                          setFieldValue('multipliers[0]', e.target.value)
                        }}
                      />
                      <div
                        className={`mb-3 flex w-full appearance-none justify-between rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800`}
                      >
                        <input
                          className={`mr-5 w-full bg-transparent focus:outline-none`}
                          type="text"
                          autoComplete="off"
                          onChange={(e) => {
                            setFieldValue('multiplierMints[0]', e.target.value)
                          }}
                          placeholder={'CmAy...A3fD'}
                          name="requireCollections"
                        />
                        <div
                          className="cursor-pointer text-xs text-gray-400"
                          onClick={() => {
                            setFieldValue(`multiplierMints`, [
                              '',
                              ...values.multiplierMints!,
                            ])
                            setFieldValue(`multipliers`, [
                              '',
                              ...values.multipliers!,
                            ])
                          }}
                        >
                          Add
                        </div>
                      </div>
                    </span>
                    {values.multiplierMints!.map(
                      (v, i) =>
                        i > 0 && (
                          <span className="flex flex-row gap-5">
                            <input
                              className="mb-3 w-1/6 appearance-none flex-col rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none"
                              type="text"
                              placeholder={'0'}
                              onChange={(e) => {
                                setFieldValue(
                                  `multipliers[${i}]`,
                                  e.target.value
                                )
                              }}
                            />
                            <div
                              className={`mb-3 flex w-full appearance-none justify-between rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800`}
                            >
                              <input
                                className={`mr-5 w-full bg-transparent focus:outline-none`}
                                type="text"
                                autoComplete="off"
                                onChange={(e) => {
                                  setFieldValue(
                                    `multiplierMints[${i}]`,
                                    e.target.value
                                  )
                                }}
                                placeholder={'CmAy...A3fD'}
                                name="requireCollections"
                              />
                              <div
                                className="cursor-pointer text-xs text-gray-400"
                                onClick={() => {
                                  setFieldValue(
                                    `multiplierMints`,
                                    values.multiplierMints!.filter(
                                      (_, ix) => ix !== i
                                    )
                                  )
                                  setFieldValue(
                                    `multipliers`,
                                    values.multipliers!.filter(
                                      (_, ix) => ix !== i
                                    )
                                  )
                                }}
                              >
                                Remove
                              </div>
                            </div>
                          </span>
                        )
                    )}
                  </div>
                )}
                {stakePool.data?.parsed.requiresAuthorization && (
                  <div className="mt-5">
                    <label
                      className="mb-2 block text-xs font-bold uppercase tracking-wide text-gray-200"
                      htmlFor="require-authorization"
                    >
                      Authorize access to specific mint
                    </label>
                    <p className="mb-2 text-sm italic text-gray-300">
                      Allow any specific mints access to the stake pool
                      (separated by commas)
                    </p>
                    <input
                      className="mb-3 block w-full appearance-none rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none"
                      type="text"
                      placeholder={'Cmwy..., A3fD..., 7Y1v...'}
                      value={mintsToAuthorize}
                      onChange={(e) => {
                        setMintsToAuthorize(e.target.value)
                      }}
                    />
                  </div>
                )}
                {rewardDistributor.data && (
                  <button type="button" onClick={() => handleMutliplier()}>
                    <div
                      className={
                        'mt-4 inline-block rounded-md bg-blue-700 px-4 py-2'
                      }
                    >
                      {loadingHandleMultipliers && (
                        <div className="mr-2 inline-block">
                          <TailSpin color="#fff" height={15} width={15} />
                        </div>
                      )}
                      Set Multipliers
                    </div>
                  </button>
                )}
                {stakePool.data?.parsed.requiresAuthorization && (
                  <button
                    type="button"
                    className={
                      'ml-5 mt-4 inline-block rounded-md bg-blue-700 px-4 py-2'
                    }
                    onClick={() => handleAuthorizeMints()}
                  >
                    <div className="flex">
                      {loadingHandleAuthorizeMints && (
                        <div className="mr-2">
                          <TailSpin color="#fff" height={15} width={15} />
                        </div>
                      )}
                      Authorize Mints
                    </div>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="w-full text-center text-gray-500">
              No stake pool found
            </div>
          )}
        </div>
      </div>
      <Footer />
    </div>
  )
}

export default AdminStakePool
