import test from 'node:test';
import assert from 'node:assert/strict';
import {incident} from '../src/incident.mjs';
test('incident workload remains available',()=>assert.equal(incident.jobs.length,3));
