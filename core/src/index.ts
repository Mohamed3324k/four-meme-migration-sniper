import { ethers } from 'ethers';
import { Logger } from './utils/Logger';
import { ConfigManager } from './config/ConfigManager';
import { MigrationDetector } from './migration-detector/MigrationDetector';
import { PancakeSwapIntegration } from './pancakeswap-integration/PancakeSwapIntegration';
import { TransitionLogic } from './transition-logic/TransitionLogic';
import { MEVProtection } from './mev-protection/MEVProtection';
import { GasOptimizer } from './gas-optimizer/GasOptimizer';
import { WalletManager } from './wallet-manager/WalletManager';
import { MonitoringService } from './monitoring/MonitoringService';
import { RiskManager } from './risk/RiskManager';

export class FourMemeMigrateSniper {
  private logger: Logger;
  private config: ConfigManager;
  private migrationDetector: MigrationDetector;
  private pancakeSwapIntegration: PancakeSwapIntegration;
  private transitionLogic: TransitionLogic;
  private mevProtection: MEVProtection;
  private gasOptimizer: GasOptimizer;
  private walletManager: WalletManager;
  private monitoringService: MonitoringService;
  private riskManager: RiskManager;
  private provider: ethers.JsonRpcProvider;
  private privateProvider?: ethers.JsonRpcProvider;
  private isRunning: boolean = false;

  constructor() {
    this.logger = new Logger('FourMemeMigrateSniper');
    this.config = new ConfigManager();
    
    // Initialize blockchain provider
    this.provider = new ethers.JsonRpcProvider(this.config.get('BSC_RPC_URL'));
    
    // Initialize private provider if configured
    const privateRpcUrl = this.config.get('PRIVATE_RPC_URL');
    if (privateRpcUrl) {
      this.privateProvider = new ethers.JsonRpcProvider(privateRpcUrl);
    }
    
    // Initialize core services
    this.migrationDetector = new MigrationDetector(this.provider, this.config);
    this.pancakeSwapIntegration = new PancakeSwapIntegration(this.provider, this.config);
    this.mevProtection = new MEVProtection(this.provider, this.config);
    this.gasOptimizer = new GasOptimizer(this.provider, this.config);
    this.walletManager = new WalletManager(this.provider, this.config);
    this.monitoringService = new MonitoringService(this.provider, this.config);
    this.riskManager = new RiskManager(this.config);
    
    // Initialize transition logic
    this.transitionLogic = new TransitionLogic(
      this.provider,
      this.config,
      this.migrationDetector,
      this.pancakeSwapIntegration
    );
  }

  public async initialize(): Promise<void> {
    try {
      this.logger.info('🚀 Initializing Four.Meme Migration Sniper...');

      // Validate configuration
      if (!this.config.validate()) {
        throw new Error('Configuration validation failed');
      }

      // Initialize core services
      await this.migrationDetector.initialize();
      await this.pancakeSwapIntegration.initialize();
      await this.mevProtection.initialize();
      await this.gasOptimizer.initialize();
      await this.walletManager.initialize();
      await this.monitoringService.initialize();
      await this.riskManager.initialize();
      await this.transitionLogic.initialize();

      this.logger.info('✅ Four.Meme Migration Sniper initialization completed successfully');
    } catch (error) {
      this.logger.error('❌ Failed to initialize Four.Meme Migration Sniper:', error);
      throw error;
    }
  }

  public async start(): Promise<void> {
    try {
      if (this.isRunning) {
        this.logger.warn('Four.Meme Migration Sniper is already running');
        return;
      }

      this.logger.info('🎯 Starting Four.Meme Migration Sniper...');
      this.isRunning = true;

      // Start core services
      await this.migrationDetector.start();
      await this.transitionLogic.start();
      await this.monitoringService.start();

      // Set up event listeners
      this.setupEventListeners();

      this.logger.info('✅ Four.Meme Migration Sniper started successfully');
    } catch (error) {
      this.logger.error('❌ Failed to start Four.Meme Migration Sniper:', error);
      this.isRunning = false;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    try {
      if (!this.isRunning) {
        this.logger.warn('Four.Meme Migration Sniper is not running');
        return;
      }

      this.logger.info('🛑 Stopping Four.Meme Migration Sniper...');
      this.isRunning = false;

      // Stop core services
      await this.migrationDetector.stop();
      await this.transitionLogic.stop();
      await this.monitoringService.stop();

      this.logger.info('✅ Four.Meme Migration Sniper stopped successfully');
    } catch (error) {
      this.logger.error('❌ Error stopping Four.Meme Migration Sniper:', error);
      throw error;
    }
  }

  public async restart(): Promise<void> {
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    await this.start();
  }

  public async addTokenToMonitor(tokenAddress: string): Promise<void> {
    try {
      this.logger.info(`📝 Adding token to monitoring: ${tokenAddress}`);
      
      await this.migrationDetector.addToken(tokenAddress);
      
      this.logger.info(`✅ Token ${tokenAddress} added to monitoring`);
    } catch (error) {
      this.logger.error(`❌ Error adding token ${tokenAddress}:`, error);
      throw error;
    }
  }

  public async removeTokenFromMonitor(tokenAddress: string): Promise<void> {
    try {
      this.logger.info(`🗑️ Removing token from monitoring: ${tokenAddress}`);
      
      await this.migrationDetector.removeToken(tokenAddress);
      
      this.logger.info(`✅ Token ${tokenAddress} removed from monitoring`);
    } catch (error) {
      this.logger.error(`❌ Error removing token ${tokenAddress}:`, error);
      throw error;
    }
  }

  private setupEventListeners(): void {
    // Migration detection events
    this.migrationDetector.on('migrationDetected', (migrationEvent) => {
      this.logger.info(`🚀 Migration detected: ${migrationEvent.tokenData.symbol}`);
      this.handleMigrationDetected(migrationEvent);
    });

    this.migrationDetector.on('statusUpdate', (statusData) => {
      this.logger.debug(`📊 Status update for ${statusData.tokenAddress}`);
    });

    // Transition logic events
    this.transitionLogic.on('transitionExecuted', (result) => {
      this.logger.info(`✅ Transition executed: ${result.tradesExecuted.length} trades`);
      this.handleTransitionExecuted(result);
    });

    this.transitionLogic.on('positionClosed', (position) => {
      this.logger.info(`💰 Position closed: ${position.profitLossPercent?.toFixed(2)}% P&L`);
      this.handlePositionClosed(position);
    });

    // Risk management events
    this.riskManager.on('riskAlert', (riskData) => {
      this.logger.warn('⚠️ Risk alert:', riskData);
      this.handleRiskAlert(riskData);
    });

    // Gas optimization events
    this.gasOptimizer.on('gasPriceUpdate', (gasData) => {
      this.logger.debug(`⛽ Gas price updated: ${ethers.formatUnits(gasData.gasPrice, 'gwei')} gwei`);
    });

    // Error handling
    process.on('uncaughtException', (error) => {
      this.logger.error('💥 Uncaught Exception:', error);
      this.stop();
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    });
  }

  private handleMigrationDetected(migrationEvent: any): void {
    try {
      this.logger.info(`🎯 Migration Event Details:`);
      this.logger.info(`  - Token: ${migrationEvent.tokenData.symbol} (${migrationEvent.tokenAddress})`);
      this.logger.info(`  - Market Cap: ${migrationEvent.preMigrationMarketCap.toFixed(4)} BNB`);
      this.logger.info(`  - Liquidity Added: ${migrationEvent.liquidityAdded.toFixed(4)} BNB`);
      this.logger.info(`  - Migration Block: ${migrationEvent.migrationBlock}`);
      this.logger.info(`  - Migration TX: ${migrationEvent.migrationTxHash}`);
      
      // Update monitoring metrics
      this.updateMigrationMetrics(migrationEvent);
      
    } catch (error) {
      this.logger.error('Error handling migration detected:', error);
    }
  }

  private handleTransitionExecuted(result: any): void {
    try {
      this.logger.info(`📊 Transition Execution Summary:`);
      this.logger.info(`  - Success: ${result.success}`);
      this.logger.info(`  - Trades Executed: ${result.tradesExecuted.length}`);
      this.logger.info(`  - Execution Time: ${result.executionTime}ms`);
      this.logger.info(`  - Total Gas Used: ${result.totalGasUsed.toString()}`);
      
      // Update performance metrics
      this.updatePerformanceMetrics(result);
      
    } catch (error) {
      this.logger.error('Error handling transition executed:', error);
    }
  }

  private handlePositionClosed(position: any): void {
    try {
      this.logger.info(`💰 Position Closed Summary:`);
      this.logger.info(`  - Position ID: ${position.id}`);
      this.logger.info(`  - Token: ${position.tokenSymbol}`);
      this.logger.info(`  - Entry Price: ${position.entryPrice?.toFixed(8)}`);
      this.logger.info(`  - Exit Price: ${position.exitPrice?.toFixed(8)}`);
      this.logger.info(`  - P&L: ${position.profitLossPercent?.toFixed(2)}%`);
      this.logger.info(`  - Exit Reason: ${position.exitReason}`);
      this.logger.info(`  - Hold Time: ${((position.exitTime - position.entryTime) / 1000).toFixed(0)}s`);
      
      // Update position metrics
      this.updatePositionMetrics(position);
      
    } catch (error) {
      this.logger.error('Error handling position closed:', error);
    }
  }

  private handleRiskAlert(riskData: any): void {
    try {
      // Handle risk alerts
      if (riskData.level === 'HIGH') {
        this.logger.warn('🚨 High risk detected, reducing position sizes');
        // Reduce position sizes or stop new positions
      } else if (riskData.level === 'CRITICAL') {
        this.logger.error('💥 Critical risk detected, stopping all trading');
        this.transitionLogic.stop();
      }
    } catch (error) {
      this.logger.error('Error handling risk alert:', error);
    }
  }

  private updateMigrationMetrics(migrationEvent: any): void {
    try {
      // Update migration metrics
      // Implementation would depend on monitoring system
      this.logger.debug('Updating migration metrics');
    } catch (error) {
      this.logger.error('Error updating migration metrics:', error);
    }
  }

  private updatePerformanceMetrics(result: any): void {
    try {
      // Update performance metrics
      // Implementation would depend on monitoring system
      this.logger.debug('Updating performance metrics');
    } catch (error) {
      this.logger.error('Error updating performance metrics:', error);
    }
  }

  private updatePositionMetrics(position: any): void {
    try {
      // Update position metrics
      // Implementation would depend on monitoring system
      this.logger.debug('Updating position metrics');
    } catch (error) {
      this.logger.error('Error updating position metrics:', error);
    }
  }

  public getStatus(): any {
    return {
      isRunning: this.isRunning,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      migrationDetector: this.migrationDetector.getStatus(),
      pancakeSwapIntegration: this.pancakeSwapIntegration.getStatus(),
      transitionLogic: this.transitionLogic.getStatus(),
      mevProtection: this.mevProtection.isProtectionEnabled(),
      gasOptimizer: this.gasOptimizer.getGasConfig(),
      walletManager: this.walletManager.getStatus(),
      riskManager: this.riskManager.getCurrentRiskLevel(),
      privateProvider: !!this.privateProvider
    };
  }

  public getMigrationStatuses(): Map<string, any> {
    return this.migrationDetector.getAllMigrationStatuses();
  }

  public getMonitoredTokens(): any[] {
    return this.migrationDetector.getAllMonitoredTokens();
  }

  public getActivePositions(): Map<string, any> {
    return this.transitionLogic.getActivePositions();
  }

  public getCompletedPositions(): Map<string, any> {
    return this.transitionLogic.getCompletedPositions();
  }

  public getPositionStats(): any {
    return this.transitionLogic.getPositionStats();
  }

  public getPerformanceMetrics(): any {
    return {
      migrationDetector: this.migrationDetector.getStatus(),
      transitionLogic: this.transitionLogic.getPositionStats(),
      gasOptimizer: this.gasOptimizer.getGasPriceHistory(),
      riskManager: this.riskManager.getCurrentRiskLevel()
    };
  }
}

// Export for use in other modules
export default FourMemeMigrateSniper;
