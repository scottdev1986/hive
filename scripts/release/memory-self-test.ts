#!/usr/bin/env bun

import { memorySelfTestCli } from "../../src/memory-service/self-test";

process.exitCode = await memorySelfTestCli({ strict: true });
