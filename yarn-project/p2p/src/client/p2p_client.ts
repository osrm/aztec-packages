import { L2Block, L2BlockSource, L2BlockDownloader } from '@aztec/archiver';

import { InMemoryTxPool } from '../tx_pool/memory_tx_pool.js';
import { TxPool } from '../tx_pool/index.js';
import { createTxIds, Tx } from './tx.js';
import { createDebugLogger } from '@aztec/foundation';

/**
 * Enum defining the possible states of the p2p client.
 */
export enum P2PClientState {
  IDLE,
  SYNCHING,
  RUNNING,
  STOPPED,
}

/**
 * The synchronisation status of the P2P client.
 */
export interface P2PSyncState {
  /**
   * The current state of the p2p client.
   */
  state: P2PClientState;
  /**
   * The block number that the p2p client is synced to.
   */
  syncedToL2Block: number;
}

/**
 * Interface of a P2P client.
 **/
export interface P2P {
  /**
   * Verifies the 'tx' and, if valid, adds it to local tx pool and forwards it to other peers.
   **/
  sendTx(tx: Tx): Promise<void>;

  /**
   * Returns all transactions in the transaction pool.
   * @returns An array of Txs.
   */
  getTxs(): Promise<Tx[]>;

  /**
   * Starts the p2p client.
   * @returns A promise signalling the completion of the block sync.
   */
  start(): Promise<void>;

  /**
   * Stops the p2p client.
   * @returns A promise signalling the completion of the stop process.
   */
  stop(): Promise<void>;

  /**
   * Indicates if the p2p client is ready for transaction submission.
   * @returns A boolean flag indicating readiness.
   */
  isReady(): Promise<boolean>;

  /*
   * Returns the current status of the p2p client.
   */
  getStatus(): Promise<P2PSyncState>;
}

/**
 * The P2P client implementation.
 */
export class P2PClient implements P2P {
  /**
   * L2 Block download that p2p client uses to stay in sync with latest blocks.
   */
  private blockDownloader: L2BlockDownloader;

  /**
   * Property that indicates whether the client is running.
   */
  private stopping = false;

  /**
   * The JS promise that will be running to keep the client's data in sync. Can be interrupted if the client is stopped.
   */
  private runningPromise!: Promise<void>;

  /**
   * Store the ID of the latest block the client has synced to.
   */
  private currentL2BlockNum = 0;

  private currentState = P2PClientState.IDLE;
  private syncPromise = Promise.resolve();
  private latestBlockNumberAtStart = -1;
  private syncResolve?: () => void = undefined;

  /**
   * In-memory P2P client constructor.
   * @param l2BlockSource - P2P client's source for fetching existing block data.
   * @param txPool - The client's instance of a transaction pool. Defaults to in-memory implementation.
   * @param log - A logger.
   */
  constructor(
    private l2BlockSource: L2BlockSource,
    private txPool: TxPool = new InMemoryTxPool(),
    private log = createDebugLogger('aztec:p2p'),
  ) {
    this.blockDownloader = new L2BlockDownloader(l2BlockSource, 1000, 100);
  }

  /**
   * Starts the P2P client.
   * @returns An empty promise signalling the synching process.
   */
  public async start() {
    if (this.currentState === P2PClientState.STOPPED) {
      throw new Error('P2P client already stopped');
    }
    if (this.currentState !== P2PClientState.IDLE) {
      return this.syncPromise;
    }

    // get the current latest block number
    this.latestBlockNumberAtStart = await this.l2BlockSource.getLatestBlockNum();

    const blockToDownloadFrom = this.currentL2BlockNum + 1;

    // if there are blocks to be retrieved, go to a synching state
    if (blockToDownloadFrom <= this.latestBlockNumberAtStart) {
      this.setCurrentState(P2PClientState.SYNCHING);
      this.syncPromise = new Promise(resolve => {
        this.syncResolve = resolve;
      });
      this.log(`Starting sync from ${blockToDownloadFrom}, latest block ${this.latestBlockNumberAtStart}`);
    } else {
      // if no blocks to be retrieved, go straight to running
      this.setCurrentState(P2PClientState.RUNNING);
      this.syncPromise = Promise.resolve();
      this.log(`Next block ${blockToDownloadFrom} already beyond latest block at ${this.latestBlockNumberAtStart}`);
    }

    // start looking for further blocks
    const blockProcess = async () => {
      while (!this.stopping) {
        const blocks = await this.blockDownloader.getL2Blocks();
        await this.handleL2Blocks(blocks);
      }
    };
    this.runningPromise = blockProcess();
    this.blockDownloader.start(blockToDownloadFrom);
    this.log(`Started block downloader from block ${blockToDownloadFrom}`);
    return this.syncPromise;
  }

  /**
   * Allows consumers to stop the instance of the P2P client.
   * 'ready' will now return 'false' and the running promise that keeps the client synced is interrupted.
   */
  public async stop() {
    this.log('Stopping p2p client...');
    this.stopping = true;
    await this.blockDownloader.stop();
    await this.runningPromise;
    this.setCurrentState(P2PClientState.STOPPED);
  }

  /**
   * Returns all transactions in the transaction pool.
   * @returns An array of Txs.
   */
  public getTxs(): Promise<Tx[]> {
    return Promise.resolve(this.txPool.getAllTxs());
  }

  /**
   * Verifies the 'tx' and, if valid, adds it to local tx pool and forwards it to other peers.
   * @param tx - The tx to verify.
   * @returns Empty promise.
   **/
  public async sendTx(tx: Tx): Promise<void> {
    const ready = await this.isReady();
    if (!ready) {
      throw new Error('P2P client not ready');
    }
    this.txPool.addTxs([tx]);
  }

  /**
   * Public function to check if the p2p client is fully synced and ready to receive txs.
   * @returns True if the P2P client is ready to receive txs.
   */
  public isReady() {
    return Promise.resolve(this.currentState === P2PClientState.RUNNING);
  }

  /**
   * Public function to check the latest block number that the P2P client is synced to.
   * @returns Block number of latest L2 Block we've synced with.
   */
  public getSyncedBlockNum() {
    return this.currentL2BlockNum;
  }

  /**
   * Method to check the status the p2p client.
   * @returns Information about p2p client status: state & syncedToBlockNum.
   */
  public getStatus(): Promise<P2PSyncState> {
    return Promise.resolve({
      state: this.currentState,
      syncedToL2Block: this.currentL2BlockNum,
    } as P2PSyncState);
  }

  /**
   * Internal method that uses the provided blocks to check against the client's tx pool.
   * @param blocks - A list of existing blocks with txs that the P2P client needs to ensure the tx pool is reconciled with.
   * @returns Empty promise.
   */
  private reconcileTxPool(blocks: L2Block[]): Promise<void> {
    for (let i = 0; i < blocks.length; i++) {
      const txIds = createTxIds(blocks[i]);
      for (let i = 0; i < txIds.length; i++) {
        this.log(`Deleting tx id ${txIds[i].toString('hex')} from tx pool`);
      }
      this.txPool.deleteTxs(txIds);
    }
    return Promise.resolve();
  }

  /**
   * Method for processing new blocks.
   * @param blocks - A list of existing blocks with txs that the P2P client needs to ensure the tx pool is reconciled with.
   * @returns Empty promise.
   */
  private async handleL2Blocks(blocks: L2Block[]): Promise<void> {
    if (!blocks.length) {
      return Promise.resolve();
    }
    await this.reconcileTxPool(blocks);
    this.currentL2BlockNum = blocks[blocks.length - 1].number;
    this.log(`Synched to block ${this.currentL2BlockNum}`);
    if (this.currentState === P2PClientState.SYNCHING && this.currentL2BlockNum >= this.latestBlockNumberAtStart) {
      this.setCurrentState(P2PClientState.RUNNING);
      if (this.syncResolve !== undefined) {
        this.syncResolve();
      }
    }
  }

  /**
   * Method to set the value of the current state.
   * @param newState - New state value.
   */
  private setCurrentState(newState: P2PClientState) {
    this.currentState = newState;
    this.log(`Moved to state ${P2PClientState[this.currentState]}`);
  }
}
