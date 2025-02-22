import {
  AccountData,
  withFindOrInitAssociatedTokenAccount,
} from '@cardinal/common'
import { executeTransaction } from '@cardinal/staking'
import {
  RewardDistributorData,
  RewardDistributorKind,
} from '@cardinal/staking/dist/cjs/programs/rewardDistributor'
import { Wallet } from '@metaplex/js'
import { BN } from '@project-serum/anchor'
import { useWallet } from '@solana/wallet-adapter-react'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { LoadingSpinner } from 'common/LoadingSpinner'
import { notify } from 'common/Notification'
import { useEnvironmentCtx } from 'providers/EnvironmentProvider'
import { TailSpin } from 'react-loader-spinner'
import * as splToken from '@solana/spl-token'
import { useMemo, useState } from 'react'
import Select from 'react-select'
import { getMintDecimalAmountFromNaturalV2 } from 'common/units'
import { FormFieldTitleInput } from 'common/FormFieldInput'
import * as Yup from 'yup'
import { tryPublicKey } from 'common/utils'
import { useFormik } from 'formik'
import { StakePoolData } from '@cardinal/staking/dist/cjs/programs/stakePool'
import { handleError } from 'api/api'

const publicKeyValidationTest = (value: string | undefined): boolean => {
  return tryPublicKey(value) ? true : false
}

const bnValidationTest = (value: string | undefined): boolean => {
  if (value === undefined) return false
  try {
    new BN(value)
    return true
  } catch (e) {
    return false
  }
}

const creationFormSchema = Yup.object({
  overlayText: Yup.string(),
  requireCollections: Yup.array()
    .of(
      Yup.string().test(
        'is-public-key',
        'Invalid collection address',
        publicKeyValidationTest
      )
    )
    .required(),
  requireCreators: Yup.array()
    .of(
      Yup.string().test(
        'is-public-key',
        'Invalid creator address',
        publicKeyValidationTest
      )
    )
    .required(),
  requiresAuthorization: Yup.boolean(),
  cooldownPeriodSeconds: Yup.number().optional().min(0),
  minStakeSeconds: Yup.number().optional().min(0),
  rewardDistributorKind: Yup.number().optional().min(0).max(2),
  rewardMintAddress: Yup.string().test(
    'is-public-key',
    'Invalid reward mint address',
    publicKeyValidationTest
  ),
  rewardAmount: Yup.string()
    .optional()
    .test('is-valid-bn', 'Invalid reward amount', bnValidationTest),
  rewardDurationSeconds: Yup.string()
    .optional()
    .test('is-valid-bn', 'Invalid reward amount', bnValidationTest),
  rewardMintSupply: Yup.string()
    .optional()
    .test('is-valid-bn', 'Invalid reward amount', bnValidationTest),
})

export type CreationForm = Yup.InferType<typeof creationFormSchema>

export function StakePoolForm({
  type = 'create',
  stakePoolData,
  rewardDistributorData,
  handleSubmit,
}: {
  type?: 'update' | 'create'
  stakePoolData?: AccountData<StakePoolData>
  rewardDistributorData?: AccountData<RewardDistributorData>
  handleSubmit: (
    values: CreationForm,
    rewardMintInfo?: splToken.MintInfo
  ) => void
}) {
  const { connection } = useEnvironmentCtx()
  const wallet = useWallet()
  const initialValues: CreationForm = {
    overlayText: stakePoolData?.parsed.overlayText ?? 'STAKED',
    requireCollections: (stakePoolData?.parsed.requiresCollections ?? []).map(
      (pk) => pk.toString()
    ),
    requireCreators: (stakePoolData?.parsed.requiresCreators ?? []).map((pk) =>
      pk.toString()
    ),
    requiresAuthorization: stakePoolData?.parsed.requiresAuthorization ?? false,
    cooldownPeriodSeconds: stakePoolData?.parsed.cooldownSeconds ?? 0,
    minStakeSeconds: stakePoolData?.parsed.minStakeSeconds ?? 0,
    rewardDistributorKind: rewardDistributorData?.parsed.kind,
    rewardMintAddress: rewardDistributorData?.parsed.rewardMint
      ? rewardDistributorData?.parsed.rewardMint.toString()
      : undefined,
    rewardAmount: rewardDistributorData?.parsed.rewardAmount
      ? rewardDistributorData?.parsed.rewardAmount.toString()
      : undefined,
    rewardDurationSeconds: rewardDistributorData?.parsed.rewardDurationSeconds
      ? rewardDistributorData?.parsed.rewardDurationSeconds.toString()
      : undefined,
    rewardMintSupply: rewardDistributorData?.parsed.maxSupply
      ? rewardDistributorData?.parsed.maxSupply.toString()
      : undefined,
  }
  const formState = useFormik({
    initialValues,
    onSubmit: (values) => {},
    validationSchema: creationFormSchema,
  })
  const { values, errors, setFieldValue, handleChange } = formState

  const [submitDisabled, setSubmitDisabled] = useState<boolean>(true)
  const [processingMintAddress, setProcessingMintAddress] =
    useState<boolean>(false)
  const [mintInfo, setMintInfo] = useState<splToken.MintInfo>()
  const [maxMintSupply, setMaxMintSupply] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(false)

  useMemo(async () => {
    if (values.rewardMintAddress) {
      if (!wallet?.connected) {
        notify({
          message: `Wallet not connected`,
          type: 'error',
        })
        return
      }
      setSubmitDisabled(true)
      setProcessingMintAddress(true)
      try {
        const mint = new PublicKey(values.rewardMintAddress)
        const checkMint = new splToken.Token(
          connection,
          mint,
          splToken.TOKEN_PROGRAM_ID,
          Keypair.generate() // unused
        )
        let mintInfo = await checkMint.getMintInfo()

        let userAta: splToken.AccountInfo | undefined = undefined
        try {
          const transaction = new Transaction()
          const mintAta = await withFindOrInitAssociatedTokenAccount(
            transaction,
            connection,
            mint,
            wallet.publicKey!,
            wallet.publicKey!,
            true
          )
          if (transaction.instructions.length > 0) {
            await executeTransaction(
              connection,
              wallet as Wallet,
              transaction,
              {}
            )
          }
          userAta = await checkMint.getAccountInfo(mintAta)
        } catch (e) {
          notify({
            message: handleError(
              e,
              "Failed to get user's associated token address for given mint"
            ),
            type: 'error',
          })
          return
        }
        setMintInfo(mintInfo)
        if (userAta) {
          const decimalAmount = getMintDecimalAmountFromNaturalV2(
            mintInfo.decimals,
            new BN(userAta.amount)
          )
          setMaxMintSupply(Number(decimalAmount.toFixed(3)))
        }
        setSubmitDisabled(false)
        setProcessingMintAddress(false)
        notify({ message: `Valid reward mint address`, type: 'success' })
      } catch (e) {
        setMintInfo(undefined)
        setSubmitDisabled(true)
        if (values.rewardMintAddress.length > 0) {
          console.log(e)
          notify({
            message: `Invalid reward mint address: ${e}`,
            type: 'error',
          })
        }
      } finally {
        setProcessingMintAddress(false)
      }
    }
  }, [values.rewardMintAddress?.toString()])

  return (
    <form className="w-full max-w-lg">
      <div className="-mx-3 flex flex-wrap">
        <div className="mb-6 mt-4 w-full px-3 md:mb-0">
          <FormFieldTitleInput
            title={'Overlay Text'}
            description={'Text to display over the receipt'}
          />
          <input
            className="mb-3 block w-full appearance-none rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none"
            type="text"
            placeholder={'STAKED'}
            name="overlayText"
            value={values.overlayText}
            onChange={handleChange}
          />
        </div>
      </div>
      <div className="-mx-3 flex flex-wrap">
        <div className="mb-6 mt-4 w-full px-3 md:mb-0">
          <FormFieldTitleInput
            title={'Collection Addresses []'}
            description={'Allow any NFTs with these collection addresses'}
          />
          <div
            className={`${
              values.requireCollections[0] !== '' &&
              errors.requireCollections?.at(0)
                ? 'border-red-500'
                : 'border-gray-500'
            } mb-3 flex appearance-none justify-between rounded border bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800`}
          >
            <input
              className={`mr-5 w-full bg-transparent focus:outline-none`}
              type="text"
              placeholder={'CmAy...A3fD'}
              name="requireCollections"
              value={values.requireCollections[0]}
              onChange={(e) =>
                setFieldValue('requireCollections[0]', e.target.value)
              }
            />
            <div
              className="cursor-pointer text-xs text-gray-400"
              onClick={() =>
                setFieldValue(`requireCollections`, [
                  '',
                  ...values.requireCollections,
                ])
              }
            >
              Add
            </div>
          </div>
          {values.requireCollections.map(
            (v, i) =>
              i > 0 && (
                <div
                  className={`${
                    errors.requireCollections?.at(i)
                      ? 'border-red-500'
                      : 'border-gray-500'
                  } mb-3 flex appearance-none justify-between rounded border bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800`}
                >
                  <input
                    className={`mr-5 w-full bg-transparent focus:outline-none`}
                    type="text"
                    placeholder={'CmAy...A3fD'}
                    name="requireCollections"
                    value={v}
                    onChange={(e) =>
                      setFieldValue(`requireCollections[${i}]`, e.target.value)
                    }
                  />
                  <div
                    className="cursor-pointer text-xs text-gray-400"
                    onClick={() =>
                      setFieldValue(
                        `requireCollections`,
                        values.requireCollections.filter((_, ix) => ix !== i)
                      )
                    }
                  >
                    Remove
                  </div>
                </div>
              )
          )}
        </div>
      </div>
      <div className="-mx-3 flex flex-wrap">
        <div className="mb-6 mt-4 w-full px-3 md:mb-0">
          <FormFieldTitleInput
            title={'Creator Addresses []'}
            description={'Allow any NFTs with these creator addresses'}
          />

          <div
            className={`${
              values.requireCreators[0] !== '' && errors.requireCreators?.at(0)
                ? 'border-red-500'
                : 'border-gray-500'
            } mb-3 flex appearance-none justify-between rounded border bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800`}
          >
            <input
              className={`mr-5 w-full bg-transparent focus:outline-none`}
              type="text"
              placeholder={'CmAy...A3fD'}
              name="requireCreators"
              value={values.requireCreators[0]}
              onChange={(e) =>
                setFieldValue('requireCreators[0]', e.target.value)
              }
            />
            <div
              className="cursor-pointer text-xs text-gray-400"
              onClick={() =>
                setFieldValue(`requireCreators`, [
                  '',
                  ...values.requireCreators,
                ])
              }
            >
              Add
            </div>
          </div>
          {values.requireCreators.map(
            (v, i) =>
              i > 0 && (
                <div
                  className={`${
                    errors.requireCreators?.at(i)
                      ? 'border-red-500'
                      : 'border-gray-500'
                  } mb-3 flex appearance-none justify-between rounded border bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800`}
                >
                  <input
                    className={`mr-5 w-full bg-transparent focus:outline-none`}
                    type="text"
                    placeholder={'CmAy...A3fD'}
                    name="requireCreators"
                    value={v}
                    onChange={(e) =>
                      setFieldValue(`requireCreators[${i}]`, e.target.value)
                    }
                  />
                  <div
                    className="cursor-pointer text-xs text-gray-400"
                    onClick={() =>
                      setFieldValue(
                        `requireCreators`,
                        values.requireCreators.filter((_, ix) => ix !== i)
                      )
                    }
                  >
                    Remove
                  </div>
                </div>
              )
          )}
        </div>
      </div>
      <div className="-mx-3 flex flex-wrap">
        <div className="mb-6 mt-4 w-full px-3 md:mb-0">
          <label
            className="mb-2 block text-xs font-bold uppercase tracking-wide text-gray-200"
            htmlFor="require-authorization"
          >
            Authorize NFTs
          </label>
          <p className="mb-2 text-sm italic text-gray-300">
            If selected, NFTs / specific mints can be arbitrarily authorized to
            enter the pool
          </p>
          <input
            className="mb-3 cursor-pointer"
            id="require-authorization"
            type="checkbox"
            name="requiresAuthorization"
            checked={values.requiresAuthorization}
            onChange={handleChange}
          />{' '}
          <span
            className="my-auto cursor-pointer text-sm"
            onClick={() =>
              setFieldValue(
                'requiresAuthorization',
                !values.requiresAuthorization
              )
            }
          >
            Require Authorization
          </span>
        </div>
      </div>
      <div className="-mx-3 flex flex-wrap">
        <div className="mb-6 mt-4 w-full px-3 md:mb-0">
          <FormFieldTitleInput
            title={'Cooldown Period Seconds'}
            description={'Period of time required prior to unstaking'}
          />
          <input
            className="mb-3 block w-full appearance-none rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none"
            type="text"
            placeholder={'0'}
            name="cooldownPeriodSeconds"
            value={values.cooldownPeriodSeconds}
            onChange={handleChange}
          />
        </div>
      </div>
      <div className="-mx-3 flex flex-wrap">
        <div className="mb-6 mt-4 w-full px-3 md:mb-0">
          <FormFieldTitleInput
            title={'Minimum Stake Seconds'}
            description={
              'Period of time to keep token staked before unstake is allowed'
            }
          />
          <input
            className="mb-3 block w-full appearance-none rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none"
            type="text"
            placeholder={'0'}
            name="minStakeSeconds"
            value={values.minStakeSeconds}
            onChange={handleChange}
          />
        </div>
      </div>
      <div>
        <div className="-mx-3 mt-5 flex flex-wrap rounded-md bg-white bg-opacity-5 pb-2">
          <div className="mb-6 mt-4 w-full px-3 md:mb-0">
            <FormFieldTitleInput
              title={'Reward Distribution'}
              description={
                'Mint tokens from the mint address or transfer tokens to the stake pool.'
              }
            />
            <Select
              styles={customStyles}
              className={`mb-3 ${type === 'update' ? 'opacity-40' : ''}`}
              isSearchable={false}
              onChange={(option) =>
                setFieldValue(
                  'rewardDistributorKind',
                  option?.value
                    ? parseInt(option?.value) || undefined
                    : undefined
                )
              }
              value={{
                value: values.rewardDistributorKind?.toString() ?? '0',
                label: values.rewardDistributorKind
                  ? RewardDistributorKind[values.rewardDistributorKind]
                  : 'None',
              }}
              options={[
                { value: '0', label: 'None' },
                { value: '1', label: 'Mint' },
                { value: '2', label: 'Transfer' },
              ]}
            />
          </div>
          {values.rewardDistributorKind && (
            <>
              <div className="relative mb-6 mt-4 w-full px-3 md:mb-0">
                {processingMintAddress ? (
                  <div className="absolute right-10">
                    <LoadingSpinner height="25px" />
                  </div>
                ) : (
                  ''
                )}
                <FormFieldTitleInput
                  title={'Reward Mint Address'}
                  description={'The mint address of the reward token'}
                />

                <input
                  className={`${
                    values.rewardMintAddress !== '' && errors.rewardMintAddress
                      ? 'border-red-500'
                      : 'border-gray-500'
                  }
                  ${
                    type === 'update' ? 'opacity-40' : ''
                  } mb-3 block w-full appearance-none rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none`}
                  type="text"
                  disabled={type === 'update'}
                  placeholder={'Enter Mint Address First: So1111..11112'}
                  value={values.rewardMintAddress}
                  onChange={(e) => {
                    setFieldValue('rewardMintAddress', e.target.value)
                  }}
                />
              </div>
              {mintInfo && (
                <>
                  <div className="mb-6 mt-4 w-1/2 px-3 md:mb-0">
                    <FormFieldTitleInput
                      title={'Reward Amount'}
                      description={
                        'Amount of token to be paid to the staked NFT'
                      }
                    />
                    <input
                      className={`${
                        errors.rewardAmount
                          ? 'border-red-500'
                          : 'border-gray-500'
                      } ${
                        type === 'update' ? 'opacity-40' : ''
                      } mb-3 block w-full appearance-none rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none`}
                      type="text"
                      placeholder={'10'}
                      disabled={submitDisabled || type === 'update'}
                      value={values.rewardAmount}
                      onChange={(e) => {
                        const amount = Number(e.target.value)
                        if (!amount && e.target.value.length != 0) {
                          notify({
                            message: `Invalid reward amount`,
                            type: 'error',
                          })
                        }
                        setFieldValue('rewardAmount', e.target.value.toString())
                      }}
                    />
                  </div>
                  <div className="mb-6 mt-4 w-1/2 px-3 md:mb-0">
                    <FormFieldTitleInput
                      title={'Reward Duration Seconds'}
                      description={
                        'Staked duration needed to receive reward amount'
                      }
                    />
                    <input
                      className={`${
                        errors.rewardDurationSeconds
                          ? 'border-red-500'
                          : 'border-gray-500'
                      } ${
                        type === 'update' ? 'opacity-40' : ''
                      } mb-3 block w-full appearance-none rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800 focus:outline-none`}
                      type="text"
                      placeholder={'60'}
                      value={values.rewardDurationSeconds}
                      disabled={submitDisabled || type === 'update'}
                      onChange={(e) => {
                        const seconds = Number(e.target.value)
                        if (!seconds && e.target.value.length !== 0) {
                          notify({
                            message: `Invalid reward duration seconds`,
                            type: 'error',
                          })
                        }
                        setFieldValue(
                          'rewardDurationSeconds',
                          e.target.value.toString()
                        )
                      }}
                    />
                  </div>

                  <div className="mb-6 mt-4 w-full px-3 md:mb-0">
                    <FormFieldTitleInput
                      title={
                        values.rewardDistributorKind ===
                        RewardDistributorKind.Mint
                          ? 'Reward Max Supply'
                          : 'Reward Transfer Amount'
                      }
                      description={
                        values.rewardDistributorKind ===
                        RewardDistributorKind.Treasury
                          ? 'Max number of tokens to mint (max: mint supply).'
                          : 'How many tokens to transfer to the stake pool for future distribution (max: your asscociated token account balance).'
                      }
                    />
                    <div
                      className={`${
                        errors.rewardMintSupply
                          ? 'border-red-500'
                          : 'border-gray-500'
                      } ${
                        type === 'update' ? 'opacity-40' : ''
                      } mb-3 flex appearance-none justify-between rounded border border-gray-500 bg-gray-700 py-3 px-4 leading-tight text-gray-200 placeholder-gray-500 focus:bg-gray-800`}
                    >
                      <input
                        className={`mr-5 w-full bg-transparent focus:outline-none`}
                        disabled={submitDisabled || type === 'update'}
                        type="text"
                        placeholder={'1000000'}
                        value={
                          values.rewardMintSupply
                            ? values.rewardMintSupply
                                .toString()
                                .replaceAll(',', '')
                                .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
                            : undefined
                        }
                        onChange={(e) => {
                          const supply = Number(
                            e.target.value.replaceAll(',', '')
                          )
                          console.log(supply)
                          if (!supply && e.target.value.length != 0) {
                            notify({
                              message: `Invalid reward mint supply`,
                              type: 'error',
                            })
                          }
                          setFieldValue(
                            'rewardMintSupply',
                            e.target.value.toString()
                          )
                        }}
                      />
                      <div
                        className="cursor-pointer"
                        onClick={() => {
                          if (
                            values.rewardDistributorKind ===
                            RewardDistributorKind.Mint
                          ) {
                            setFieldValue(
                              'rewardMintSupply',
                              mintInfo.supply.toNumber()
                            )
                          } else {
                            setFieldValue('rewardMintSupply', maxMintSupply)
                          }
                        }}
                      >
                        Max
                      </div>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <button
        disabled={Boolean(values.rewardDistributorKind && submitDisabled)}
        type="button"
        onClick={async () => {
          try {
            setLoading(true)
            await handleSubmit(values, mintInfo)
          } finally {
            setLoading(false)
          }
        }}
      >
        <div
          className={
            submitDisabled && values.rewardDistributorKind
              ? 'mt-4 inline-block rounded-md bg-blue-700 px-4 py-2 opacity-50'
              : 'mt-4 inline-block rounded-md bg-blue-700 px-4 py-2'
          }
        >
          {loading && (
            <div className="mr-2 inline-block">
              <TailSpin color="#fff" height={15} width={15} />
            </div>
          )}
          {type.charAt(0).toUpperCase() + type.slice(1)} Pool
        </div>
      </button>
    </form>
  )
}

export const customStyles = {
  control: (base: {}) => ({
    ...base,
    background: 'rgb(55, 65, 81)',
    borderColor: 'rgb(107, 114, 128)',
  }),
  Input: (base: {}) => ({
    ...base,
    color: 'white',
  }),
  menu: (base: {}) => ({
    ...base,
    background: 'rgb(55, 65, 81)',
    '&:hover': {
      background: 'rgb(55, 65, 81)',
    },
    '&:focus': {
      background: 'rgb(75, 85, 99) !important',
    },
    borderRadius: 0,
    marginTop: 0,
  }),
  option: (base: {}) => ({
    ...base,
    background: 'rgb(55, 65, 81)',
    '&:hover': {
      background: 'rgb(75, 85, 99)',
    },
    '&:focus': {
      background: 'rgb(75, 85, 99) !important',
    },
  }),
  singleValue: (provided: {}) => ({
    ...provided,
    color: 'white',
  }),
}
