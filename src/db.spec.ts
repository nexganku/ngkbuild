import {
    suite,
    test,
} from 'mocha-typescript';
import {
    createFileNode,
    Database,
} from './db';
import assert = require('assert');

/**
 * Tests for node update marking
 */
@suite('Database')
export class DatabaseTest {
    @test
    'constructor()'(): void {
        const db = new Database();
        assert.strictEqual(db.fileNodes.size, 0);
        assert.strictEqual(db.commandNodes.size, 0);
        assert.strictEqual(db.updateNodes.size, 0);
    }

    @test
    'markUpdate()'(): void {
        const fileNode = createFileNode('a');
        const db = new Database([fileNode]);
        assert(!db.updateNodes.size);

        db.markUpdate(fileNode);
        assert.deepEqual(db.updateNodes, new Set([fileNode]));

        db.markUpdate(fileNode);
        assert.deepEqual(db.updateNodes, new Set([fileNode]));
    }

    @test
    'unmarkUpdate()'(): void {
        const fileNode = createFileNode('a');
        const db = new Database([fileNode]);
        db.markUpdate(fileNode);
        assert.deepEqual(db.updateNodes, new Set([fileNode]));

        db.unmarkUpdate(fileNode);
        assert.strictEqual(db.updateNodes.size, 0);

        db.unmarkUpdate(fileNode);
        assert.strictEqual(db.updateNodes.size, 0);
    }

    @test
    'addFileNode() when file node does not exist'(): void {
        const db = new Database();
        assert.strictEqual(db.fileNodes.size, 0);
        assert.strictEqual(db.updateNodes.size, 0);

        const fileNode = db.addFileNode('a');
        assert.deepEqual(db.updateNodes, new Set([fileNode])); // file node is marked for update
    }

    @test
    'addFileNode() when file node already exists'(): void {
        const fileNode = createFileNode('a');
        const db = new Database([fileNode]);
        assert.strictEqual(db.fileNodes.size, 1);
        assert.strictEqual(db.updateNodes.size, 0);

        assert.strictEqual(db.addFileNode('a'), fileNode); // returns same file node
        assert.strictEqual(db.updateNodes.size, 0); // file node is not marked for update
    }
}
