import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';
import { ConfigManager } from '../config/ConfigManager';
import { MigrationDetector, MigrationEvent } from '../migration-detector/MigrationDetector';
import { PancakeSwapIntegration, SwapParams, SwapResult } from '../pancakeswap-integration/PancakeSwapIntegration';

export interface TransitionStrategy {
  name: string;
  description: string;
  buyAmount: bigint; // BNB amount to buy
  sellThreshold: number; // Profit threshold to sell
  stopLossThreshold: number; // Stop loss threshold
  maxHoldTime: number; // Maximum hold time in milliseconds
  enablePartialSells: boolean; // Enable partial profit taking
  partialSellPercentages: number[]; // Percentages to sell at different profit levels
}

export interface TransitionConfig {
  defaultStrategy: string;
  strategies: Map<string, TransitionStrategy>;
  maxConcurrentTrades: number;
  maxTotalExposure: bigint; // Maximum total BNB exposure
  enableRiskManagement: boolean;
  enableProfitTaking: boolean;
  enableStopLosses: boolean;
  gasPriceBuffer: number;
  slippageBuffer: number;
}

export interface TradePosition {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  entryPrice: number;
  entryAmount: bigint; // BNB amount invested
  tokenAmount: bigint; // Token amount received
  strategy: string;
  entryTime: number;
  currentPrice?: number;
  currentValue?: bigint;
  profitLoss?: number;
  profitLossPercent?: number;
  status: 'ACTIVE' | 'CLOSED' | 'STOPPED';
  exitPrice?: number;
  exitTime?: number;
  exitReason?: string;
  gasUsed?: bigint;
  totalFees?: bigint;
}

export interface TransitionResult {
  success: boolean;
  migrationEvent: MigrationEvent;
  tradesExecuted: TradePosition[];
  totalProfit: number;
  totalGasUsed: bigint;
  executionTime: number;
  error?: string;
}

export class TransitionLogic extends EventEmitter {
  private logger: Logger;
  private config: ConfigManager;
  private provider: ethers.JsonRpcProvider;
  private migrationDetector: MigrationDetector;
  private pancakeSwapIntegration: PancakeSwapIntegration;
  private transitionConfig: TransitionConfig;
  private activePositions: Map<string, TradePosition> = new Map();
  private completedPositions: Map<string, TradePosition> = new Map();
  private isRunning: boolean = false;
  private positionCounter: number = 0;

  constructor(
    provider: ethers.JsonRpcProvider,
    config: ConfigManager,
    migrationDetector: MigrationDetector,
    pancakeSwapIntegration: PancakeSwapIntegration
  ) {
    super();
    this.logger = new Logger('TransitionLogic');
    this.config = config;
    this.provider = provider;
    this.migrationDetector = migrationDetector;
    this.pancakeSwapIntegration = pancakeSwapIntegration;
    this.transitionConfig = this.loadTransitionConfig();
  }

  public async initialize(): Promise<void> {
    try {
      this.logger.info('🔧 Initializing Transition Logic...');
      
      // Set up migration event listener
      this.migrationDetector.on('migrationDetected', this.handleMigrationEvent.bind(this));
      
      this.logger.info('✅ Transition Logic initialized successfully');
    } catch (error) {
      this.logger.error('❌ Failed to initialize Transition Logic:', error);
      throw error;
    }
  }

  public async start(): Promise<void> {
    try {
      if (this.isRunning) {
        this.logger.warn('Transition Logic is already running');
        return;
      }

      this.logger.info('🎯 Starting Transition Logic...');
      this.isRunning = true;

      // Start position monitoring
      this.startPositionMonitoring();

      this.logger.info('✅ Transition Logic started successfully');
    } catch (error) {
      this.logger.error('❌ Failed to start Transition Logic:', error);
      this.isRunning = false;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    try {
      if (!this.isRunning) {
        this.logger.warn('Transition Logic is not running');
        return;
      }

      this.logger.info('🛑 Stopping Transition Logic...');
      this.isRunning = false;

      this.logger.info('✅ Transition Logic stopped successfully');
    } catch (error) {
      this.logger.error('❌ Error stopping Transition Logic:', error);
      throw error;
    }
  }

  private async handleMigrationEvent(migrationEvent: MigrationEvent): Promise<void> {
    try {
      this.logger.info(`🚀 Handling migration event for ${migrationEvent.tokenData.symbol}`);

      // Check if we can take new positions
      if (this.activePositions.size >= this.transitionConfig.maxConcurrentTrades) {
        this.logger.warn('Maximum concurrent trades reached, skipping migration');
        return;
      }

      // Get migration swap data
      const migrationSwapData = await this.pancakeSwapIntegration.getMigrationSwapData(
        migrationEvent.tokenAddress
      );

      // Check liquidity threshold
      if (migrationSwapData.liquidityBNB < this.transitionConfig.strategies.get('default')?.buyAmount || BigInt(0)) {
        this.logger.warn('Insufficient liquidity for trading');
        return;
      }

      // Execute transition strategy
      const result = await this.executeTransitionStrategy(migrationEvent, migrationSwapData);

      if (result.success) {
        this.logger.info(`✅ Transition executed successfully for ${migrationEvent.tokenData.symbol}`);
        this.emit('transitionExecuted', result);
      } else {
        this.logger.error(`❌ Transition failed for ${migrationEvent.tokenData.symbol}: ${result.error}`);
      }
    } catch (error) {
      this.logger.error('Error handling migration event:', error);
    }
  }

  private async executeTransitionStrategy(
    migrationEvent: MigrationEvent,
    migrationSwapData: any
  ): Promise<TransitionResult> {
    try {
      const startTime = Date.now();
      const strategy = this.transitionConfig.strategies.get(this.transitionConfig.defaultStrategy);
      
      if (!strategy) {
        throw new Error('Default strategy not found');
      }

      this.logger.info(`📊 Executing strategy: ${strategy.name}`);

      // Create wallet for trading
      const wallet = await this.createTradingWallet();
      
      // Execute buy order
      const buyResult = await this.executeBuyOrder(wallet, migrationEvent, migrationSwapData, strategy);
      
      if (!buyResult.success) {
        throw new Error(`Buy order failed: ${buyResult.error}`);
      }

      // Create position
      const position = await this.createPosition(migrationEvent, buyResult, strategy);
      this.activePositions.set(position.id, position);

      const result: TransitionResult = {
        success: true,
        migrationEvent,
        tradesExecuted: [position],
        totalProfit: 0, // Will be calculated when position is closed
        totalGasUsed: buyResult.gasUsed || BigInt(0),
        executionTime: Date.now() - startTime
      };

      this.logger.info(`✅ Transition strategy executed: Position ${position.id} created`);
      
      return result;
    } catch (error) {
      this.logger.error('Error executing transition strategy:', error);
      return {
        success: false,
        migrationEvent,
        tradesExecuted: [],
        totalProfit: 0,
        totalGasUsed: BigInt(0),
        executionTime: 0,
        error: error.message
      };
    }
  }

  private async executeBuyOrder(
    wallet: ethers.Wallet,
    migrationEvent: MigrationEvent,
    migrationSwapData: any,
    strategy: TransitionStrategy
  ): Promise<SwapResult> {
    try {
      this.logger.info(`🛒 Executing buy order: ${ethers.formatEther(strategy.buyAmount)} BNB`);

      // Prepare swap parameters
      const path = [this.pancakeSwapIntegration['WBNB_ADDRESS'], migrationEvent.tokenAddress];
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
      
      // Calculate minimum amount out with slippage buffer
      const amountsOut = await this.pancakeSwapIntegration.getAmountsOut(strategy.buyAmount, path);
      const amountOutMin = BigInt(Math.floor(Number(amountsOut[1]) * (1 - this.transitionConfig.slippageBuffer)));

      const swapParams: SwapParams = {
        amountIn: strategy.buyAmount,
        amountOutMin,
        path,
        deadline,
        recipient: wallet.address
      };

      // Execute swap
      const result = await this.pancakeSwapIntegration.swapExactETHForTokens(wallet, swapParams);
      
      return result;
    } catch (error) {
      this.logger.error('Error executing buy order:', error);
      throw error;
    }
  }

  private async createPosition(
    migrationEvent: MigrationEvent,
    buyResult: SwapResult,
    strategy: TransitionStrategy
  ): Promise<TradePosition> {
    try {
      const positionId = this.generatePositionId();
      const entryPrice = migrationEvent.migrationStatus.currentMarketCap / Number(buyResult.amountOut) * 1e18;
      
      const position: TradePosition = {
        id: positionId,
        tokenAddress: migrationEvent.tokenAddress,
        tokenSymbol: migrationEvent.tokenData.symbol,
        entryPrice,
        entryAmount: buyResult.amountIn,
        tokenAmount: buyResult.amountOut,
        strategy: strategy.name,
        entryTime: Date.now(),
        status: 'ACTIVE'
      };

      this.logger.info(`📊 Position created: ${positionId} for ${position.tokenSymbol}`);
      
      return position;
    } catch (error) {
      this.logger.error('Error creating position:', error);
      throw error;
    }
  }

  private async createTradingWallet(): Promise<ethers.Wallet> {
    try {
      // This would create or get a trading wallet
      // For now, return a placeholder
      const privateKey = this.config.get('TRADING_WALLET_PRIVATE_KEY');
      return new ethers.Wallet(privateKey, this.provider);
    } catch (error) {
      this.logger.error('Error creating trading wallet:', error);
      throw error;
    }
  }

  private startPositionMonitoring(): void {
    // Monitor positions every 5 seconds
    setInterval(async () => {
      try {
        await this.monitorPositions();
      } catch (error) {
        this.logger.error('Error monitoring positions:', error);
      }
    }, 5000);
  }

  private async monitorPositions(): Promise<void> {
    try {
      for (const [positionId, position] of this.activePositions) {
        await this.updatePositionStatus(position);
        
        // Check for exit conditions
        const shouldExit = await this.checkExitConditions(position);
        
        if (shouldExit.exit) {
          await this.executeExitStrategy(position, shouldExit.reason);
        }
      }
    } catch (error) {
      this.logger.error('Error monitoring positions:', error);
    }
  }

  private async updatePositionStatus(position: TradePosition): Promise<void> {
    try {
      // Get current token price
      const currentPrice = await this.getCurrentTokenPrice(position.tokenAddress);
      const currentValue = BigInt(Math.floor(Number(position.tokenAmount) * currentPrice / 1e18));
      
      // Calculate profit/loss
      const profitLoss = Number(currentValue) - Number(position.entryAmount);
      const profitLossPercent = (profitLoss / Number(position.entryAmount)) * 100;
      
      // Update position
      position.currentPrice = currentPrice;
      position.currentValue = currentValue;
      position.profitLoss = profitLoss;
      position.profitLossPercent = profitLossPercent;
      
      this.activePositions.set(position.id, position);
    } catch (error) {
      this.logger.error(`Error updating position ${position.id}:`, error);
    }
  }

  private async checkExitConditions(position: TradePosition): Promise<{ exit: boolean; reason?: string }> {
    try {
      const strategy = this.transitionConfig.strategies.get(position.strategy);
      if (!strategy) {
        return { exit: true, reason: 'Strategy not found' };
      }

      // Check stop loss
      if (this.transitionConfig.enableStopLosses && position.profitLossPercent! < -strategy.stopLossThreshold) {
        return { exit: true, reason: 'Stop loss triggered' };
      }

      // Check profit threshold
      if (this.transitionConfig.enableProfitTaking && position.profitLossPercent! >= strategy.sellThreshold) {
        return { exit: true, reason: 'Profit threshold reached' };
      }

      // Check max hold time
      const holdTime = Date.now() - position.entryTime;
      if (holdTime > strategy.maxHoldTime) {
        return { exit: true, reason: 'Max hold time reached' };
      }

      // Check partial sells
      if (strategy.enablePartialSells) {
        for (const percentage of strategy.partialSellPercentages) {
          if (position.profitLossPercent! >= percentage && !position.partialSells?.includes(percentage)) {
            return { exit: true, reason: `Partial sell at ${percentage}% profit` };
          }
        }
      }

      return { exit: false };
    } catch (error) {
      this.logger.error(`Error checking exit conditions for position ${position.id}:`, error);
      return { exit: false };
    }
  }

  private async executeExitStrategy(position: TradePosition, reason: string): Promise<void> {
    try {
      this.logger.info(`🚪 Executing exit strategy for position ${position.id}: ${reason}`);

      // Create wallet for selling
      const wallet = await this.createTradingWallet();
      
      // Execute sell order
      const sellResult = await this.executeSellOrder(wallet, position);
      
      if (sellResult.success) {
        // Update position
        position.status = 'CLOSED';
        position.exitPrice = position.currentPrice;
        position.exitTime = Date.now();
        position.exitReason = reason;
        position.gasUsed = (position.gasUsed || BigInt(0)) + (sellResult.gasUsed || BigInt(0));
        
        // Move to completed positions
        this.activePositions.delete(position.id);
        this.completedPositions.set(position.id, position);
        
        this.logger.info(`✅ Position ${position.id} closed: ${position.profitLossPercent?.toFixed(2)}% P&L`);
        
        // Emit position closed event
        this.emit('positionClosed', position);
      } else {
        this.logger.error(`❌ Failed to close position ${position.id}: ${sellResult.error}`);
        position.status = 'STOPPED';
      }
    } catch (error) {
      this.logger.error(`Error executing exit strategy for position ${position.id}:`, error);
    }
  }

  private async executeSellOrder(wallet: ethers.Wallet, position: TradePosition): Promise<SwapResult> {
    try {
      this.logger.info(`💰 Executing sell order for position ${position.id}`);

      // Prepare swap parameters
      const path = [position.tokenAddress, this.pancakeSwapIntegration['WBNB_ADDRESS']];
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
      
      // Calculate minimum amount out with slippage buffer
      const amountsOut = await this.pancakeSwapIntegration.getAmountsOut(position.tokenAmount, path);
      const amountOutMin = BigInt(Math.floor(Number(amountsOut[1]) * (1 - this.transitionConfig.slippageBuffer)));

      const swapParams: SwapParams = {
        amountIn: position.tokenAmount,
        amountOutMin,
        path,
        deadline,
        recipient: wallet.address
      };

      // Execute swap
      const result = await this.pancakeSwapIntegration.swapExactTokensForETH(wallet, swapParams);
      
      return result;
    } catch (error) {
      this.logger.error('Error executing sell order:', error);
      throw error;
    }
  }

  private async getCurrentTokenPrice(tokenAddress: string): Promise<number> {
    try {
      // Get current token price from PancakeSwap
      const migrationSwapData = await this.pancakeSwapIntegration.getMigrationSwapData(tokenAddress);
      return migrationSwapData.tokenPrice;
    } catch (error) {
      this.logger.error('Error getting current token price:', error);
      return 0;
    }
  }

  private generatePositionId(): string {
    return `pos_${Date.now()}_${++this.positionCounter}`;
  }

  private loadTransitionConfig(): TransitionConfig {
    const strategies = new Map<string, TransitionStrategy>();
    
    // Default aggressive strategy
    strategies.set('aggressive', {
      name: 'aggressive',
      description: 'High risk, high reward strategy',
      buyAmount: ethers.parseEther('0.1'),
      sellThreshold: 50, // 50% profit
      stopLossThreshold: 20, // 20% stop loss
      maxHoldTime: 3600000, // 1 hour
      enablePartialSells: true,
      partialSellPercentages: [25, 50, 75] // Sell 25% at 25% profit, etc.
    });

    // Conservative strategy
    strategies.set('conservative', {
      name: 'conservative',
      description: 'Low risk, steady returns strategy',
      buyAmount: ethers.parseEther('0.05'),
      sellThreshold: 20, // 20% profit
      stopLossThreshold: 10, // 10% stop loss
      maxHoldTime: 1800000, // 30 minutes
      enablePartialSells: false,
      partialSellPercentages: []
    });

    return {
      defaultStrategy: this.config.get('DEFAULT_STRATEGY', 'aggressive'),
      strategies,
      maxConcurrentTrades: this.config.get('MAX_CONCURRENT_TRADES', 5),
      maxTotalExposure: ethers.parseEther(this.config.get('MAX_TOTAL_EXPOSURE', '1')),
      enableRiskManagement: this.config.get('ENABLE_RISK_MANAGEMENT', true),
      enableProfitTaking: this.config.get('ENABLE_PROFIT_TAKING', true),
      enableStopLosses: this.config.get('ENABLE_STOP_LOSSES', true),
      gasPriceBuffer: this.config.get('GAS_PRICE_BUFFER', 1.2),
      slippageBuffer: this.config.get('SLIPPAGE_BUFFER', 0.05)
    };
  }

  public getActivePositions(): Map<string, TradePosition> {
    return new Map(this.activePositions);
  }

  public getCompletedPositions(): Map<string, TradePosition> {
    return new Map(this.completedPositions);
  }

  public getPositionStats(): any {
    const activePositions = Array.from(this.activePositions.values());
    const completedPositions = Array.from(this.completedPositions.values());
    
    const totalProfit = completedPositions.reduce((sum, pos) => sum + (pos.profitLoss || 0), 0);
    const totalGasUsed = completedPositions.reduce((sum, pos) => sum + Number(pos.gasUsed || 0), 0);
    
    return {
      activePositions: activePositions.length,
      completedPositions: completedPositions.length,
      totalProfit,
      totalGasUsed,
      averageProfit: completedPositions.length > 0 ? totalProfit / completedPositions.length : 0,
      successRate: completedPositions.length > 0 ? 
        completedPositions.filter(pos => (pos.profitLoss || 0) > 0).length / completedPositions.length : 0
    };
  }

  public getStatus(): any {
    return {
      isRunning: this.isRunning,
      activePositions: this.activePositions.size,
      completedPositions: this.completedPositions.size,
      maxConcurrentTrades: this.transitionConfig.maxConcurrentTrades,
      defaultStrategy: this.transitionConfig.defaultStrategy,
      enableRiskManagement: this.transitionConfig.enableRiskManagement,
      enableProfitTaking: this.transitionConfig.enableProfitTaking,
      enableStopLosses: this.transitionConfig.enableStopLosses
    };
  }
}
