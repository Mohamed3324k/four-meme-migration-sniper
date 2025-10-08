import { ethers } from 'ethers';
import { Logger } from '../utils/Logger';
import { ConfigManager } from '../config/ConfigManager';

export interface PancakeSwapConfig {
  routerAddress: string;
  factoryAddress: string;
  wbnbAddress: string;
  maxSlippage: number;
  deadlineBuffer: number; // Seconds
  gasPriceMultiplier: number;
  maxGasPrice: number;
  minLiquidityThreshold: number; // Minimum liquidity in BNB
  enablePriceImpactProtection: boolean;
  maxPriceImpact: number; // Maximum price impact percentage
}

export interface SwapParams {
  amountIn: bigint;
  amountOutMin: bigint;
  path: string[];
  deadline: number;
  recipient: string;
}

export interface LiquidityInfo {
  pairAddress: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  liquidityBNB: number;
  liquidityUSD: number;
  price: number;
  priceImpact: number;
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: bigint;
  amountIn: bigint;
  amountOut: bigint;
  priceImpact: number;
  slippage: number;
  executionTime: number;
  error?: string;
}

export interface MigrationSwapData {
  tokenAddress: string;
  pairAddress: string;
  liquidityBNB: number;
  tokenPrice: number;
  priceImpact: number;
  slippage: number;
  estimatedGasCost: bigint;
  recommendedSlippage: number;
}

export class PancakeSwapIntegration {
  private logger: Logger;
  private config: ConfigManager;
  private provider: ethers.JsonRpcProvider;
  private pancakeConfig: PancakeSwapConfig;
  private routerContract: ethers.Contract;
  private factoryContract: ethers.Contract;
  private wbnbContract: ethers.Contract;

  // PancakeSwap contract addresses (BNB Chain)
  private readonly PANCAKESWAP_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
  private readonly PANCAKESWAP_FACTORY = '0xcA143Ce0Fe65960E6Aa4D42C8d3cE161c2B6604f';
  private readonly WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

  constructor(provider: ethers.JsonRpcProvider, config: ConfigManager) {
    this.logger = new Logger('PancakeSwapIntegration');
    this.config = config;
    this.provider = provider;
    this.pancakeConfig = this.loadPancakeConfig();
    
    // Initialize contracts
    this.routerContract = new ethers.Contract(
      this.pancakeConfig.routerAddress,
      this.getRouterABI(),
      provider
    );
    
    this.factoryContract = new ethers.Contract(
      this.pancakeConfig.factoryAddress,
      this.getFactoryABI(),
      provider
    );
    
    this.wbnbContract = new ethers.Contract(
      this.pancakeConfig.wbnbAddress,
      this.getWBNBABI(),
      provider
    );
  }

  public async initialize(): Promise<void> {
    try {
      this.logger.info('🔧 Initializing PancakeSwap Integration...');
      
      // Verify contract connections
      await this.routerContract.getAmountsOut(ethers.parseEther('1'), [this.WBNB_ADDRESS, this.WBNB_ADDRESS]);
      await this.factoryContract.allPairsLength();
      await this.wbnbContract.name();
      
      this.logger.info('✅ PancakeSwap Integration initialized successfully');
    } catch (error) {
      this.logger.error('❌ Failed to initialize PancakeSwap Integration:', error);
      throw error;
    }
  }

  public async swapExactETHForTokens(
    wallet: ethers.Wallet,
    swapParams: SwapParams
  ): Promise<SwapResult> {
    try {
      this.logger.info(`🔄 Executing ETH to Token swap: ${ethers.formatEther(swapParams.amountIn)} BNB`);

      const startTime = Date.now();
      
      // Calculate price impact
      const priceImpact = await this.calculatePriceImpact(swapParams.amountIn, swapParams.path);
      
      // Check price impact protection
      if (this.pancakeConfig.enablePriceImpactProtection && priceImpact > this.pancakeConfig.maxPriceImpact) {
        throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}%`);
      }

      // Get optimal gas price
      const gasPrice = await this.getOptimalGasPrice();
      
      // Prepare transaction
      const transaction = await this.routerContract.swapExactETHForTokensSupportingFeeOnTransferTokens.populateTransaction(
        swapParams.amountOutMin,
        swapParams.path,
        swapParams.recipient,
        swapParams.deadline,
        {
          value: swapParams.amountIn,
          gasPrice: gasPrice
        }
      );

      // Execute transaction
      const tx = await wallet.sendTransaction(transaction);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        // Calculate actual amounts
        const amountOut = await this.calculateActualAmountOut(receipt, swapParams.path);
        const slippage = this.calculateSlippage(swapParams.amountOutMin, amountOut);
        
        const result: SwapResult = {
          success: true,
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          amountIn: swapParams.amountIn,
          amountOut,
          priceImpact,
          slippage,
          executionTime: Date.now() - startTime
        };

        this.logger.info(`✅ ETH to Token swap successful: ${tx.hash}`);
        return result;
      } else {
        throw new Error('Transaction failed');
      }
    } catch (error) {
      this.logger.error('❌ Error executing ETH to Token swap:', error);
      return {
        success: false,
        amountIn: swapParams.amountIn,
        amountOut: BigInt(0),
        priceImpact: 0,
        slippage: 0,
        executionTime: 0,
        error: error.message
      };
    }
  }

  public async swapExactTokensForETH(
    wallet: ethers.Wallet,
    swapParams: SwapParams
  ): Promise<SwapResult> {
    try {
      this.logger.info(`🔄 Executing Token to ETH swap: ${ethers.formatEther(swapParams.amountIn)} tokens`);

      const startTime = Date.now();
      
      // Calculate price impact
      const priceImpact = await this.calculatePriceImpact(swapParams.amountIn, swapParams.path);
      
      // Check price impact protection
      if (this.pancakeConfig.enablePriceImpactProtection && priceImpact > this.pancakeConfig.maxPriceImpact) {
        throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}%`);
      }

      // Get optimal gas price
      const gasPrice = await this.getOptimalGasPrice();
      
      // Prepare transaction
      const transaction = await this.routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens.populateTransaction(
        swapParams.amountIn,
        swapParams.amountOutMin,
        swapParams.path,
        swapParams.recipient,
        swapParams.deadline,
        {
          gasPrice: gasPrice
        }
      );

      // Execute transaction
      const tx = await wallet.sendTransaction(transaction);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        // Calculate actual amounts
        const amountOut = await this.calculateActualAmountOut(receipt, swapParams.path);
        const slippage = this.calculateSlippage(swapParams.amountOutMin, amountOut);
        
        const result: SwapResult = {
          success: true,
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          amountIn: swapParams.amountIn,
          amountOut,
          priceImpact,
          slippage,
          executionTime: Date.now() - startTime
        };

        this.logger.info(`✅ Token to ETH swap successful: ${tx.hash}`);
        return result;
      } else {
        throw new Error('Transaction failed');
      }
    } catch (error) {
      this.logger.error('❌ Error executing Token to ETH swap:', error);
      return {
        success: false,
        amountIn: swapParams.amountIn,
        amountOut: BigInt(0),
        priceImpact: 0,
        slippage: 0,
        executionTime: 0,
        error: error.message
      };
    }
  }

  public async getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]> {
    try {
      const amounts = await this.routerContract.getAmountsOut(amountIn, path);
      return amounts;
    } catch (error) {
      this.logger.error('Error getting amounts out:', error);
      throw error;
    }
  }

  public async getLiquidityInfo(pairAddress: string): Promise<LiquidityInfo> {
    try {
      const pairContract = new ethers.Contract(
        pairAddress,
        this.getPairABI(),
        this.provider
      );

      const [reserves, totalSupply, token0, token1] = await Promise.all([
        pairContract.getReserves(),
        pairContract.totalSupply(),
        pairContract.token0(),
        pairContract.token1()
      ]);

      // Determine which token is WBNB
      const isToken0WBNB = token0.toLowerCase() === this.WBNB_ADDRESS.toLowerCase();
      const wbnbReserve = isToken0WBNB ? reserves[0] : reserves[1];
      const tokenReserve = isToken0WBNB ? reserves[1] : reserves[0];

      // Calculate liquidity in BNB
      const liquidityBNB = Number(wbnbReserve) / 1e18;
      
      // Calculate price (simplified)
      const price = Number(wbnbReserve) / Number(tokenReserve);
      
      // Calculate price impact (simplified)
      const priceImpact = this.calculatePriceImpactFromReserves(wbnbReserve, tokenReserve);

      const liquidityInfo: LiquidityInfo = {
        pairAddress,
        token0,
        token1,
        reserve0: reserves[0],
        reserve1: reserves[1],
        totalSupply,
        liquidityBNB,
        liquidityUSD: liquidityBNB * 300, // Assuming $300 per BNB
        price,
        priceImpact
      };

      return liquidityInfo;
    } catch (error) {
      this.logger.error('Error getting liquidity info:', error);
      throw error;
    }
  }

  public async findPairAddress(tokenA: string, tokenB: string): Promise<string | null> {
    try {
      const pairAddress = await this.factoryContract.getPair(tokenA, tokenB);
      
      if (pairAddress === '0x0000000000000000000000000000000000000000') {
        return null;
      }

      return pairAddress;
    } catch (error) {
      this.logger.error('Error finding pair address:', error);
      return null;
    }
  }

  public async getMigrationSwapData(tokenAddress: string): Promise<MigrationSwapData> {
    try {
      this.logger.info(`📊 Getting migration swap data for token: ${tokenAddress}`);

      // Find pair address
      const pairAddress = await this.findPairAddress(tokenAddress, this.WBNB_ADDRESS);
      if (!pairAddress) {
        throw new Error('PancakeSwap pair not found');
      }

      // Get liquidity info
      const liquidityInfo = await this.getLiquidityInfo(pairAddress);

      // Calculate recommended slippage based on liquidity
      const recommendedSlippage = this.calculateRecommendedSlippage(liquidityInfo.liquidityBNB);

      // Estimate gas cost
      const estimatedGasCost = await this.estimateGasCost();

      const migrationSwapData: MigrationSwapData = {
        tokenAddress,
        pairAddress,
        liquidityBNB: liquidityInfo.liquidityBNB,
        tokenPrice: liquidityInfo.price,
        priceImpact: liquidityInfo.priceImpact,
        slippage: recommendedSlippage,
        estimatedGasCost,
        recommendedSlippage
      };

      this.logger.info(`✅ Migration swap data retrieved: ${liquidityInfo.liquidityBNB.toFixed(4)} BNB liquidity`);
      
      return migrationSwapData;
    } catch (error) {
      this.logger.error('Error getting migration swap data:', error);
      throw error;
    }
  }

  private async calculatePriceImpact(amountIn: bigint, path: string[]): Promise<number> {
    try {
      // Get current reserves
      const pairAddress = await this.findPairAddress(path[0], path[1]);
      if (!pairAddress) {
        throw new Error('Pair not found');
      }

      const liquidityInfo = await this.getLiquidityInfo(pairAddress);
      
      // Calculate price impact based on trade size vs liquidity
      const tradeSizeBNB = Number(amountIn) / 1e18;
      const priceImpact = (tradeSizeBNB / liquidityInfo.liquidityBNB) * 100;
      
      return priceImpact;
    } catch (error) {
      this.logger.error('Error calculating price impact:', error);
      return 0;
    }
  }

  private calculatePriceImpactFromReserves(wbnbReserve: bigint, tokenReserve: bigint): number {
    try {
      // Simplified price impact calculation
      const liquidityBNB = Number(wbnbReserve) / 1e18;
      const liquidityToken = Number(tokenReserve) / 1e18;
      
      // Price impact based on liquidity ratio
      const ratio = liquidityBNB / liquidityToken;
      return Math.min(ratio * 0.1, 10); // Max 10% price impact
    } catch (error) {
      this.logger.error('Error calculating price impact from reserves:', error);
      return 0;
    }
  }

  private calculateRecommendedSlippage(liquidityBNB: number): number {
    try {
      // Calculate recommended slippage based on liquidity
      if (liquidityBNB < 1) {
        return 0.1; // 10% for very low liquidity
      } else if (liquidityBNB < 5) {
        return 0.05; // 5% for low liquidity
      } else if (liquidityBNB < 20) {
        return 0.03; // 3% for medium liquidity
      } else {
        return 0.01; // 1% for high liquidity
      }
    } catch (error) {
      this.logger.error('Error calculating recommended slippage:', error);
      return 0.05; // Default 5%
    }
  }

  private calculateSlippage(expectedAmount: bigint, actualAmount: bigint): number {
    try {
      if (expectedAmount === BigInt(0)) {
        return 0;
      }
      
      const slippage = Number(expectedAmount - actualAmount) / Number(expectedAmount) * 100;
      return Math.max(0, slippage);
    } catch (error) {
      this.logger.error('Error calculating slippage:', error);
      return 0;
    }
  }

  private async calculateActualAmountOut(receipt: any, path: string[]): Promise<bigint> {
    try {
      // This would parse the transaction receipt to get actual amount out
      // For now, return a placeholder
      return BigInt(0);
    } catch (error) {
      this.logger.error('Error calculating actual amount out:', error);
      return BigInt(0);
    }
  }

  private async getOptimalGasPrice(): Promise<bigint> {
    try {
      const feeData = await this.provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || BigInt(5 * 1e9);
      
      // Apply multiplier
      const optimalGasPrice = BigInt(Math.floor(Number(baseGasPrice) * this.pancakeConfig.gasPriceMultiplier));
      
      // Ensure within limits
      const maxGasPrice = BigInt(this.pancakeConfig.maxGasPrice * 1e9);
      
      return optimalGasPrice > maxGasPrice ? maxGasPrice : optimalGasPrice;
    } catch (error) {
      this.logger.error('Error getting optimal gas price:', error);
      return BigInt(10 * 1e9); // Fallback to 10 gwei
    }
  }

  private async estimateGasCost(): Promise<bigint> {
    try {
      // Estimate gas cost for a typical swap
      const gasPrice = await this.getOptimalGasPrice();
      const gasLimit = BigInt(200000); // Typical gas limit for swaps
      
      return gasPrice * gasLimit;
    } catch (error) {
      this.logger.error('Error estimating gas cost:', error);
      return BigInt(0);
    }
  }

  private loadPancakeConfig(): PancakeSwapConfig {
    return {
      routerAddress: this.config.get('PANCAKESWAP_ROUTER', this.PANCAKESWAP_ROUTER),
      factoryAddress: this.config.get('PANCAKESWAP_FACTORY', this.PANCAKESWAP_FACTORY),
      wbnbAddress: this.config.get('WBNB_ADDRESS', this.WBNB_ADDRESS),
      maxSlippage: this.config.get('MAX_SLIPPAGE', 0.05),
      deadlineBuffer: this.config.get('DEADLINE_BUFFER', 300),
      gasPriceMultiplier: this.config.get('GAS_PRICE_MULTIPLIER', 1.2),
      maxGasPrice: this.config.get('MAX_GAS_PRICE', 20),
      minLiquidityThreshold: this.config.get('MIN_LIQUIDITY_THRESHOLD', 1),
      enablePriceImpactProtection: this.config.get('ENABLE_PRICE_IMPACT_PROTECTION', true),
      maxPriceImpact: this.config.get('MAX_PRICE_IMPACT', 0.1)
    };
  }

  private getRouterABI(): any[] {
    return [
      "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable",
      "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external",
      "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
      "function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)"
    ];
  }

  private getFactoryABI(): any[] {
    return [
      "function getPair(address tokenA, address tokenB) external view returns (address pair)",
      "function allPairsLength() external view returns (uint)"
    ];
  }

  private getPairABI(): any[] {
    return [
      "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
      "function totalSupply() external view returns (uint)",
      "function token0() external view returns (address)",
      "function token1() external view returns (address)"
    ];
  }

  private getWBNBABI(): any[] {
    return [
      "function name() external view returns (string)",
      "function symbol() external view returns (string)",
      "function decimals() external view returns (uint8)"
    ];
  }

  public getStatus(): any {
    return {
      routerAddress: this.pancakeConfig.routerAddress,
      factoryAddress: this.pancakeConfig.factoryAddress,
      wbnbAddress: this.pancakeConfig.wbnbAddress,
      maxSlippage: this.pancakeConfig.maxSlippage,
      gasPriceMultiplier: this.pancakeConfig.gasPriceMultiplier,
      maxGasPrice: this.pancakeConfig.maxGasPrice,
      minLiquidityThreshold: this.pancakeConfig.minLiquidityThreshold,
      enablePriceImpactProtection: this.pancakeConfig.enablePriceImpactProtection,
      maxPriceImpact: this.pancakeConfig.maxPriceImpact
    };
  }
}
