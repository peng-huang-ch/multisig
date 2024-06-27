import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';

import { CoralMultisig } from '../target/types/coral_multisig';
import { assert } from 'chai';

describe('multisig', () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.getProvider());

  const program = anchor.workspace.CoralMultisig as Program<CoralMultisig>;

  it('Tests the multisig program', async () => {
    const multisig = anchor.web3.Keypair.generate();
    const [multisigSigner, nonce] = anchor.web3.PublicKey.findProgramAddressSync([multisig.publicKey.toBuffer()], program.programId);
    const multisigSize = 200; // Big enough.

    const ownerA = anchor.web3.Keypair.generate();
    const ownerB = anchor.web3.Keypair.generate();
    const ownerC = anchor.web3.Keypair.generate();
    const ownerD = anchor.web3.Keypair.generate();
    const owners = [ownerA.publicKey, ownerB.publicKey, ownerC.publicKey];

    const threshold = new anchor.BN(2);
    const createMultisigIx = await program.account.multisig.createInstruction(multisig, multisigSize);

    const txSize = 1000; // Big enough, cuz I'm lazy.
    await program.methods
      .createMultisig(owners, threshold, nonce)
      .accounts({
        multisig: multisig.publicKey,
      })
      .preInstructions([createMultisigIx])
      .signers([multisig])
      .rpc();

    let multisigAccount = await program.account.multisig.fetch(multisig.publicKey);

    assert.strictEqual(multisigAccount.nonce, nonce);
    assert.ok(multisigAccount.threshold.eq(new anchor.BN(2)));
    assert.deepStrictEqual(multisigAccount.owners, owners);
    assert.ok(multisigAccount.ownerSetSeqno === 0);

    const pid = program.programId;
    const accounts = [
      {
        pubkey: multisig.publicKey,
        isWritable: true,
        isSigner: false,
      },
      {
        pubkey: multisigSigner,
        isWritable: false,
        isSigner: true,
      },
    ];
    const newOwners = [ownerA.publicKey, ownerB.publicKey, ownerD.publicKey];
    const setOwnersIx = await program.methods
      .setOwners(newOwners)
      .accounts({
        multisig: multisig.publicKey,
      })
      .instruction();
    const data = setOwnersIx.data;

    const transaction = anchor.web3.Keypair.generate();
    const createdTransactionIx = await program.account.transaction.createInstruction(transaction, txSize);
    await program.rpc.createTransaction(pid, accounts, data, {
      accounts: {
        multisig: multisig.publicKey,
        transaction: transaction.publicKey,
        proposer: ownerA.publicKey,
      },
      instructions: [createdTransactionIx],
      signers: [transaction, ownerA],
    });

    const txAccount = await program.account.transaction.fetch(transaction.publicKey);

    assert.ok(txAccount.programId.equals(pid));
    assert.deepStrictEqual(txAccount.accounts, accounts);
    assert.deepStrictEqual(txAccount.data, data);
    assert.ok(txAccount.multisig.equals(multisig.publicKey));
    assert.deepStrictEqual(txAccount.didExecute, false);
    assert.ok(txAccount.ownerSetSeqno === 0);

    // Other owner approves transaction.
    await program.methods
      .approve()
      .accounts({
        multisig: multisig.publicKey,
        transaction: transaction.publicKey,
        owner: ownerB.publicKey,
      })
      .signers([ownerB])
      .rpc();

    // Now that we've reached the threshold, send the transaction.
    await program.rpc.executeTransaction({
      accounts: {
        multisig: multisig.publicKey,
        multisigSigner,
        transaction: transaction.publicKey,
      },
      remainingAccounts: program.instruction.setOwners
        .accounts({
          multisig: multisig.publicKey,
          multisigSigner,
        })
        // Change the signer status on the vendor signer since it's signed by the program, not the client.
        .map((meta) => (meta.pubkey.equals(multisigSigner) ? { ...meta, isSigner: false } : meta))
        .concat({
          pubkey: program.programId,
          isWritable: false,
          isSigner: false,
        }),
    });

    multisigAccount = await program.account.multisig.fetch(multisig.publicKey);

    assert.strictEqual(multisigAccount.nonce, nonce);
    assert.ok(multisigAccount.threshold.eq(new anchor.BN(2)));
    assert.deepStrictEqual(multisigAccount.owners, newOwners);
    assert.ok(multisigAccount.ownerSetSeqno === 1);
  });

  it('Assert Unique Owners', async () => {
    const multisig = anchor.web3.Keypair.generate();
    const [_multisigSigner, nonce] = await anchor.web3.PublicKey.findProgramAddress([multisig.publicKey.toBuffer()], program.programId);
    const multisigSize = 200; // Big enough.

    const ownerA = anchor.web3.Keypair.generate();
    const ownerB = anchor.web3.Keypair.generate();
    const owners = [ownerA.publicKey, ownerB.publicKey, ownerA.publicKey];

    const threshold = new anchor.BN(2);
    try {
      await program.rpc.createMultisig(owners, threshold, nonce, {
        accounts: {
          multisig: multisig.publicKey,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        instructions: [await program.account.multisig.createInstruction(multisig, multisigSize)],
        signers: [multisig],
      });
      assert.fail();
    } catch (err) {
      const error = err.error;
      assert.strictEqual(error.errorCode.number, 6008);
      assert.strictEqual(error.errorMessage, 'Owners must be unique');
    }
  });
});
