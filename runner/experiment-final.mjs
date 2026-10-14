#!/usr/bin/env bun
// Owner-side compatibility wrapper: never copied into coding containers.
import { evaluateContract } from '../scenarios/shop/hidden/experiment-contract.mjs';
const result=evaluateContract(process.argv[2]);
console.log(JSON.stringify({hidden:result.pass?'pass':'fail',...result}));
process.exitCode=result.pass?0:1;
