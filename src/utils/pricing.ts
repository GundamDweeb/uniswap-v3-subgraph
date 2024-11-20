/* eslint-disable prefer-const */
import { ONE_BD, ZERO_BD, ZERO_BI } from './constants'
import { Bundle, Pool, Token } from './../types/schema'
import { Address, BigDecimal, BigInt, Bytes } from '@graphprotocol/graph-ts'
import { exponentToBigDecimal, safeDiv } from '../utils/index'

const WETH_ADDRESS = '0x4200000000000000000000000000000000000006'
const USDBC_WETH_03_POOL = '0x4c36388be6f416a29c8d8eee81c771ce6be14b18'
const USDC_WETH_03_POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224'

export function STABLE_TOKEN_POOL(block: BigInt) : string { return block.lt(BigInt.fromI32(12520407)) ? USDBC_WETH_03_POOL :USDC_WETH_03_POOL }


// token where amounts should contribute to tracked volume and liquidity
// usually tokens that many tokens are paired with s
export let WHITELIST_TOKENS: string[] = [
  WETH_ADDRESS, // WETH
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDCb
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" // USDC
]

let MINIMUM_ETH_LOCKED = BigDecimal.fromString('0.01')

let Q192 = BigInt.fromI32(2).pow(192).toBigDecimal()

export function sqrtPriceX96ToTokenPrices(sqrtPriceX96: BigInt, token0: Token, token1: Token): BigDecimal[] {
  let num = sqrtPriceX96.times(sqrtPriceX96).toBigDecimal()
  let denom = BigDecimal.fromString(Q192.toString())
  let price1 = num
    .div(denom)
    .times(exponentToBigDecimal(token0.decimals))
    .div(exponentToBigDecimal(token1.decimals))

  let price0 = safeDiv(BigDecimal.fromString('1'), price1)
  return [price0, price1]
}

// weird blocks https://explorer.offchainlabs.com/tx/0x1c295207effcdaa54baa7436068c57448ff8ace855b8d6f3f9c424b4b7603960

export function getEthPriceInUSD(blockNumber: BigInt): BigDecimal {
  // fetch eth prices for each stablecoin
  let usdcPool = Pool.load(Address.fromString(STABLE_TOKEN_POOL(blockNumber))) // eth is token0

  // need to only count ETH as having valid USD price if lots of ETH in pool
  if (usdcPool && usdcPool.totalValueLockedToken0.gt(MINIMUM_ETH_LOCKED)) {
    return usdcPool.token1Price
  } else {
    return ZERO_BD
  }
}

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export function findEthPerToken(token: Token, otherToken: Token): BigDecimal {
  if (token.id == Address.fromString(WETH_ADDRESS)) {
    return ONE_BD
  }
  let whiteList = token.whitelistPools
  // for now just take USD from pool with greatest TVL
  // need to update this to actually detect best rate based on liquidity distribution
  let largestLiquidityETH = ZERO_BD
  let priceSoFar = ZERO_BD
  for (let i = 0; i < whiteList.length; ++i) {
    let poolAddress = whiteList[i]
    let pool = Pool.load(poolAddress)!
    if (pool.liquidity.gt(ZERO_BI)) {
      if (pool.token0 == token.id && (pool.token1 != otherToken.id || !WHITELIST_TOKENS.includes(pool.token0.toHexString()))) {
        // whitelist token is token1
        let token1 = Token.load(pool.token1)!
        // get the derived ETH in pool
        let ethLocked = pool.totalValueLockedToken1.times(token1.derivedETH)
        if (ethLocked.gt(largestLiquidityETH) && ethLocked.gt(MINIMUM_ETH_LOCKED)) {
          largestLiquidityETH = ethLocked
          // token1 per our token * Eth per token1
          priceSoFar = pool.token1Price.times(token1.derivedETH as BigDecimal)
        }
      }
      if (pool.token1 == token.id && (pool.token0 != otherToken.id || !WHITELIST_TOKENS.includes(pool.token1.toHexString()))) {
        let token0 = Token.load(pool.token0)!
        // get the derived ETH in pool
        let ethLocked = pool.totalValueLockedToken0.times(token0.derivedETH)
        if (ethLocked.gt(largestLiquidityETH) && ethLocked.gt(MINIMUM_ETH_LOCKED)) {
          largestLiquidityETH = ethLocked
          // token0 per our token * ETH per token0
          priceSoFar = pool.token0Price.times(token0.derivedETH as BigDecimal)
        }
      }
    }
  }
  return priceSoFar // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedAmountUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let bundle = Bundle.load(Bytes.fromI32(1))!
  let price0USD = token0.derivedETH.times(bundle.ethPriceUSD)
  let price1USD = token1.derivedETH.times(bundle.ethPriceUSD)

  // both are whitelist tokens, return sum of both amounts
  if (WHITELIST_TOKENS.includes(token0.id.toHexString()) && WHITELIST_TOKENS.includes(token1.id.toHexString())) {
    return tokenAmount0.times(price0USD).plus(tokenAmount1.times(price1USD))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST_TOKENS.includes(token0.id.toHexString()) && !WHITELIST_TOKENS.includes(token1.id.toHexString())) {
    return tokenAmount0.times(price0USD).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST_TOKENS.includes(token0.id.toHexString()) && WHITELIST_TOKENS.includes(token1.id.toHexString())) {
    return tokenAmount1.times(price1USD).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked amount is 0
  return ZERO_BD
}