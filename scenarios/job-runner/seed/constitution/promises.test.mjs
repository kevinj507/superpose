import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCost} from '../src/accounting.mjs';
import {completeOnce} from '../src/ledger.mjs';
test('published rates count recorded requests once',()=>{const r={id:'one',model:'small',input:1000,output:500};assert.equal(estimateCost([r,r]),.002);assert.throws(()=>estimateCost([{...r,input:-1}]));});
test('completed side effects survive a revised incident plan',()=>{const effects=new Map();completeOnce(effects,'one');completeOnce(effects,'one');assert.equal(effects.get('one'),1);});
