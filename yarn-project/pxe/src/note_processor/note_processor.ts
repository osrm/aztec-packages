import {
  type AztecNode,
  type EncryptedNoteL2BlockL2Logs,
  L1NotePayload,
  type L2Block,
  TaggedNote,
} from '@aztec/circuit-types';
import { type NoteProcessorStats } from '@aztec/circuit-types/stats';
import {
  type AztecAddress,
  INITIAL_L2_BLOCK_NUM,
  MAX_NEW_NOTE_HASHES_PER_TX,
  type PublicKey,
} from '@aztec/circuits.js';
import { type Fr } from '@aztec/foundation/fields';
import { type Logger, createDebugLogger } from '@aztec/foundation/log';
import { Timer } from '@aztec/foundation/timer';
import { type KeyStore } from '@aztec/key-store';
import { type AcirSimulator } from '@aztec/simulator';

import { type DeferredNoteDao } from '../database/deferred_note_dao.js';
import { type IncomingNoteDao } from '../database/incoming_note_dao.js';
import { type PxeDatabase } from '../database/index.js';
import { type OutgoingNoteDao } from '../database/outgoing_note_dao.js';
import { getAcirSimulator } from '../simulator/index.js';
import { produceNoteDaos } from './produce_note_dao.js';

/**
 * Contains all the decrypted data in this array so that we can later batch insert it all into the database.
 */
interface ProcessedData {
  /** Holds L2 block. */
  block: L2Block;
  /** DAOs of processed incoming notes. */
  incomingNotes: IncomingNoteDao[];
  /** DAOs of processed outgoing notes. */
  outgoingNotes: OutgoingNoteDao[];
}

/**
 * NoteProcessor is responsible for decrypting logs and converting them to notes via their originating contracts
 * before storing them against their owner.
 */
export class NoteProcessor {
  /** Keeps track of processing time since an instance is created. */
  public readonly timer: Timer = new Timer();

  /** Stats accumulated for this processor. */
  public readonly stats: NoteProcessorStats = {
    seen: 0,
    decryptedIncoming: 0,
    decryptedOutgoing: 0,
    deferred: 0,
    failed: 0,
    blocks: 0,
    txs: 0,
  };

  private constructor(
    public readonly account: AztecAddress,
    /** The public counterpart to the secret key to be used in the decryption of incoming note logs. */
    private readonly ivpkM: PublicKey,
    /** The public counterpart to the secret key to be used in the decryption of outgoing note logs. */
    private readonly ovpkM: PublicKey,
    private keyStore: KeyStore,
    private db: PxeDatabase,
    private node: AztecNode,
    private startingBlock: number,
    private simulator: AcirSimulator,
    private log: Logger,
  ) {}

  public static async create(
    account: AztecAddress,
    keyStore: KeyStore,
    db: PxeDatabase,
    node: AztecNode,
    startingBlock: number = INITIAL_L2_BLOCK_NUM,
    simulator = getAcirSimulator(db, node, keyStore),
    log = createDebugLogger('aztec:note_processor'),
  ) {
    const ivpkM = await keyStore.getMasterIncomingViewingPublicKey(account);
    const ovpkM = await keyStore.getMasterOutgoingViewingPublicKey(account);

    return new NoteProcessor(account, ivpkM, ovpkM, keyStore, db, node, startingBlock, simulator, log);
  }

  /**
   * Check if the NoteProcessor is synchronized with the remote block number.
   * The function queries the remote block number from the AztecNode and compares it with the syncedToBlock value in the NoteProcessor.
   * If the values are equal, then the NoteProcessor is considered to be synchronized, otherwise not.
   *
   * @returns A boolean indicating whether the NoteProcessor is synchronized with the remote block number or not.
   */
  public async isSynchronized() {
    const remoteBlockNumber = await this.node.getBlockNumber();
    return this.getSyncedToBlock() === remoteBlockNumber;
  }

  /**
   * Returns synchronization status (ie up to which block has been synced ) for this note processor.
   */
  public get status() {
    return { syncedToBlock: this.getSyncedToBlock() };
  }

  private getSyncedToBlock(): number {
    return this.db.getSynchedBlockNumberForPublicKey(this.ivpkM) ?? this.startingBlock - 1;
  }

  /**
   * Extracts new user-relevant notes from the information contained in the provided L2 blocks and encrypted logs.
   *
   * @throws If the number of blocks and encrypted logs do not match.
   * @param l2Blocks - L2 blocks to be processed.
   * @param encryptedL2BlockLogs - Encrypted logs associated with the L2 blocks.
   * @returns A promise that resolves once the processing is completed.
   */
  public async process(l2Blocks: L2Block[], encryptedL2BlockLogs: EncryptedNoteL2BlockL2Logs[]): Promise<void> {
    if (l2Blocks.length !== encryptedL2BlockLogs.length) {
      throw new Error(
        `Number of blocks and EncryptedLogs is not equal. Received ${l2Blocks.length} blocks, ${encryptedL2BlockLogs.length} encrypted logs.`,
      );
    }
    if (l2Blocks.length === 0) {
      return;
    }

    const blocksAndNotes: ProcessedData[] = [];
    // Keep track of notes that we couldn't process because the contract was not found.
    // Note that there are no deferred outgoing notes because we don't need the contract there for anything since we
    // are not attempting to derive a nullifier.
    const deferredNoteDaosIncoming: DeferredNoteDao[] = [];

    const ivskM = await this.keyStore.getMasterSecretKey(this.ivpkM);
    const ovskM = await this.keyStore.getMasterSecretKey(this.ovpkM);

    // Iterate over both blocks and encrypted logs.
    for (let blockIndex = 0; blockIndex < encryptedL2BlockLogs.length; ++blockIndex) {
      this.stats.blocks++;
      const { txLogs } = encryptedL2BlockLogs[blockIndex];
      const block = l2Blocks[blockIndex];
      const dataStartIndexForBlock =
        block.header.state.partial.noteHashTree.nextAvailableLeafIndex -
        block.body.numberOfTxsIncludingPadded * MAX_NEW_NOTE_HASHES_PER_TX;

      // We are using set for `userPertainingTxIndices` to avoid duplicates. This would happen in case there were
      // multiple encrypted logs in a tx pertaining to a user.
      const incomingNotes: IncomingNoteDao[] = [];
      const outgoingNotes: OutgoingNoteDao[] = [];

      // Iterate over all the encrypted logs and try decrypting them. If successful, store the note.
      for (let indexOfTxInABlock = 0; indexOfTxInABlock < txLogs.length; ++indexOfTxInABlock) {
        this.stats.txs++;
        const dataStartIndexForTx = dataStartIndexForBlock + indexOfTxInABlock * MAX_NEW_NOTE_HASHES_PER_TX;
        const newNoteHashes = block.body.txEffects[indexOfTxInABlock].noteHashes;
        // Note: Each tx generates a `TxL2Logs` object and for this reason we can rely on its index corresponding
        //       to the index of a tx in a block.
        const txFunctionLogs = txLogs[indexOfTxInABlock].functionLogs;
        const excludedIndices: Set<number> = new Set();
        for (const functionLogs of txFunctionLogs) {
          for (const log of functionLogs.logs) {
            this.stats.seen++;
            const incomingTaggedNote = TaggedNote.decryptAsIncoming(log.data, ivskM)!;
            const outgoingTaggedNote = TaggedNote.decryptAsOutgoing(log.data, ovskM)!;

            if (incomingTaggedNote || outgoingTaggedNote) {
              if (
                incomingTaggedNote &&
                outgoingTaggedNote &&
                !incomingTaggedNote.notePayload.equals(outgoingTaggedNote.notePayload)
              ) {
                throw new Error('Incoming and outgoing note payloads do not match.');
              }

              const payload = incomingTaggedNote?.notePayload || outgoingTaggedNote?.notePayload;

              const txHash = block.body.txEffects[indexOfTxInABlock].txHash;
              const { incomingNote, outgoingNote, incomingDeferredNote } = await produceNoteDaos(
                this.simulator,
                incomingTaggedNote ? this.ivpkM : undefined,
                outgoingTaggedNote ? this.ovpkM : undefined,
                payload,
                txHash,
                newNoteHashes,
                dataStartIndexForTx,
                excludedIndices,
                this.log,
              );

              if (incomingNote) {
                incomingNotes.push(incomingNote);
                this.stats.decryptedIncoming++;
              }
              if (outgoingNote) {
                outgoingNotes.push(outgoingNote);
                this.stats.decryptedOutgoing++;
              }
              if (incomingDeferredNote) {
                deferredNoteDaosIncoming.push(incomingDeferredNote);
                this.stats.deferred++;
              }

              if (incomingNote == undefined && outgoingNote == undefined && incomingDeferredNote == undefined) {
                this.stats.failed++;
              }
            }
          }
        }
      }

      blocksAndNotes.push({
        block: l2Blocks[blockIndex],
        incomingNotes,
        outgoingNotes,
      });
    }

    await this.processBlocksAndNotes(blocksAndNotes);
    await this.processDeferredNotes(deferredNoteDaosIncoming);

    const syncedToBlock = l2Blocks[l2Blocks.length - 1].number;
    await this.db.setSynchedBlockNumberForPublicKey(this.ivpkM, syncedToBlock);

    this.log.debug(`Synched block ${syncedToBlock}`);
  }

  /**
   * Process the given blocks and their associated transaction auxiliary data.
   * This function updates the database with information about new transactions,
   * user-pertaining transaction indices, and auxiliary data. It also removes nullified
   * transaction auxiliary data from the database. This function keeps track of new nullifiers
   * and ensures all other transactions are updated with newly settled block information.
   *
   * @param blocksAndNotes - Array of objects containing L2 blocks, user-pertaining transaction indices, and NoteDaos.
   */
  private async processBlocksAndNotes(blocksAndNotes: ProcessedData[]) {
    const incomingNotes = blocksAndNotes.flatMap(b => b.incomingNotes);
    const outgoingNotes = blocksAndNotes.flatMap(b => b.outgoingNotes);
    if (incomingNotes.length || outgoingNotes.length) {
      await this.db.addNotes(incomingNotes, outgoingNotes);
      incomingNotes.forEach(noteDao => {
        this.log.verbose(
          `Added incoming note for contract ${noteDao.contractAddress} at slot ${
            noteDao.storageSlot
          } with nullifier ${noteDao.siloedNullifier.toString()}`,
        );
      });
      outgoingNotes.forEach(noteDao => {
        this.log.verbose(`Added outgoing note for contract ${noteDao.contractAddress} at slot ${noteDao.storageSlot}`);
      });
    }

    const newNullifiers: Fr[] = blocksAndNotes.flatMap(b =>
      b.block.body.txEffects.flatMap(txEffect => txEffect.nullifiers),
    );
    const removedNotes = await this.db.removeNullifiedNotes(newNullifiers, this.ivpkM);
    removedNotes.forEach(noteDao => {
      this.log.verbose(
        `Removed note for contract ${noteDao.contractAddress} at slot ${
          noteDao.storageSlot
        } with nullifier ${noteDao.siloedNullifier.toString()}`,
      );
    });
  }

  /**
   * Store the given deferred notes in the database for later decoding.
   *
   * @param deferredNoteDaos - notes that are intended for us but we couldn't process because the contract was not found.
   */
  private async processDeferredNotes(deferredNoteDaos: DeferredNoteDao[]) {
    if (deferredNoteDaos.length) {
      await this.db.addDeferredNotes(deferredNoteDaos);
      deferredNoteDaos.forEach(noteDao => {
        this.log.verbose(
          `Deferred note for contract ${noteDao.contractAddress} at slot ${
            noteDao.storageSlot
          } in tx ${noteDao.txHash.toString()}`,
        );
      });
    }
  }

  /**
   * Retry decoding the given deferred notes because we now have the contract code.
   *
   * @param deferredNoteDaos - notes that we have previously deferred because the contract was not found
   * @returns An array of incoming notes that were successfully decoded.
   *
   * @remarks Caller is responsible for making sure that we have the contract for the
   * deferred notes provided: we will not retry notes that fail again.
   */
  public async decodeDeferredNotes(deferredNoteDaos: DeferredNoteDao[]): Promise<IncomingNoteDao[]> {
    const excludedIndices: Set<number> = new Set();
    const incomingNotes: IncomingNoteDao[] = [];

    for (const deferredNote of deferredNoteDaos) {
      const { ivpkM, note, contractAddress, storageSlot, noteTypeId, txHash, newNoteHashes, dataStartIndexForTx } =
        deferredNote;
      const payload = new L1NotePayload(note, contractAddress, storageSlot, noteTypeId);

      if (!ivpkM.equals(this.ivpkM)) {
        // The note is not for this account, so we skip it.
        continue;
      }

      const { incomingNote } = await produceNoteDaos(
        this.simulator,
        this.ivpkM,
        undefined,
        payload,
        txHash,
        newNoteHashes,
        dataStartIndexForTx,
        excludedIndices,
        this.log,
      );

      if (!incomingNote) {
        throw new Error('Deferred note could not be decoded.');
      }

      incomingNotes.push(incomingNote);
      this.stats.decryptedIncoming++;
    }

    return incomingNotes;
  }
}
