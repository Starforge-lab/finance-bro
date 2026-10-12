import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveCsvToDocument } from '../src/exports/save-csv-document';

const resultCodes = { Canceled: 0, Success: -1 };

describe('saveCsvToDocument', () => {
  it('returns cancellation without creating or touching a file', async () => {
    let fileCreated = false;
    const result = await saveCsvToDocument(
      { resultCode: resultCodes.Canceled, data: 'content://provider/ignored-csv' },
      'csv content',
      resultCodes,
      () => {
        fileCreated = true;
        throw new Error('cancellation must not create a file');
      },
    );

    assert.equal(result, 'cancelled');
    assert.equal(fileCreated, false);
  });

  it('rejects unsuccessful or destination-less picker results before file operations', async () => {
    let fileCreated = false;
    const documentForUri = () => {
      fileCreated = true;
      throw new Error('invalid picker result must not create a file');
    };

    await assert.rejects(
      saveCsvToDocument({ resultCode: 1, data: 'content://unused' }, 'csv', resultCodes, documentForUri),
      /did not return a destination/,
    );
    await assert.rejects(
      saveCsvToDocument({ resultCode: resultCodes.Success }, 'csv', resultCodes, documentForUri),
      /did not return a destination/,
    );
    for (const data of ['Intent { dat=content://provider/document/csv flg=0x43 }', 'file:///tmp/csv', 'content://']) {
      await assert.rejects(
        saveCsvToDocument({ resultCode: resultCodes.Success, data }, 'csv', resultCodes, documentForUri),
        /did not return a destination/,
      );
    }
    assert.equal(fileCreated, false);
  });

  it('writes the selected URI and leaves it intact after a successful write', async () => {
    const uri = 'content://provider/document/selected-csv';
    const content = 'id,amount_inr\r\nfictional,1.23';
    let writtenContent: string | undefined;
    let deleted = false;
    const result = await saveCsvToDocument(
      { resultCode: resultCodes.Success, data: uri },
      content,
      resultCodes,
      (selectedUri) => {
        assert.equal(selectedUri, uri);
        return {
          write: async (value) => { writtenContent = value; },
          delete: () => { deleted = true; },
        };
      },
    );

    assert.equal(result, 'saved');
    assert.equal(writtenContent, content);
    assert.equal(deleted, false);
  });

  it('deletes only the selected URI after a write failure', async () => {
    const uri = 'content://provider/document/selected-csv';
    const content = 'id,amount_inr\r\nfictional,1.23';
    const writeError = new Error('write failed');
    let deleted = false;

    await assert.rejects(
      saveCsvToDocument(
        { resultCode: resultCodes.Success, data: uri },
        content,
        resultCodes,
        (selectedUri) => {
          assert.equal(selectedUri, uri);
          return {
            write: async (value) => { assert.equal(value, content); throw writeError; },
            delete: () => { deleted = true; },
          };
        },
      ),
      (error: unknown) => error === writeError,
    );

    assert.equal(deleted, true);
  });
});
