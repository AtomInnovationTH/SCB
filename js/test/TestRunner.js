/**
 * Zero-dependency test micro-framework.
 * Works in Node.js and browser.
 */

let _suiteCount = 0;
let _passCount = 0;
let _failCount = 0;
let _currentSuite = '';

const _isNode = typeof process !== 'undefined' && process.versions?.node;
const _red = _isNode ? '\x1b[31m' : '';
const _green = _isNode ? '\x1b[32m' : '';
const _yellow = _isNode ? '\x1b[33m' : '';
const _reset = _isNode ? '\x1b[0m' : '';
const _bold = _isNode ? '\x1b[1m' : '';

function log(msg) {
    if (_isNode) {
        process.stdout.write(msg + '\n');
    } else {
        console.log(msg);
    }
}

export async function describe(name, fn) {
    _currentSuite = name;
    _suiteCount++;
    log(`\n${_bold}▸ ${name}${_reset}`);
    await fn();
}

export async function it(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            await result;
        }
        _passCount++;
        log(`  ${_green}✓${_reset} ${name}`);
    } catch (e) {
        _failCount++;
        log(`  ${_red}✗ ${name}${_reset}`);
        log(`    ${_red}${e.message}${_reset}`);
    }
}

export const assert = {
    equal(actual, expected, msg) {
        if (actual !== expected) {
            throw new Error(msg || `Expected ${expected}, got ${actual}`);
        }
    },
    
    notEqual(actual, expected, msg) {
        if (actual === expected) {
            throw new Error(msg || `Expected not ${expected}`);
        }
    },
    
    ok(value, msg) {
        if (!value) {
            throw new Error(msg || `Expected truthy, got ${value}`);
        }
    },
    
    closeTo(actual, expected, tolerance, msg) {
        if (Math.abs(actual - expected) > tolerance) {
            throw new Error(msg || `Expected ${actual} to be within ${tolerance} of ${expected} (diff: ${Math.abs(actual - expected)})`);
        }
    },
    
    throws(fn, msg) {
        let threw = false;
        try { fn(); } catch (e) { threw = true; }
        if (!threw) throw new Error(msg || 'Expected function to throw');
    },
    
    deepEqual(actual, expected, msg) {
        const aStr = JSON.stringify(actual);
        const eStr = JSON.stringify(expected);
        if (aStr !== eStr) {
            throw new Error(msg || `Expected ${eStr}, got ${aStr}`);
        }
    },
    
    isType(value, type, msg) {
        if (typeof value !== type) {
            throw new Error(msg || `Expected type ${type}, got ${typeof value}`);
        }
    },
};

export function summary() {
    const total = _passCount + _failCount;
    log(`\n${_bold}═══════════════════════════════════════${_reset}`);
    log(`${_bold}Suites: ${_suiteCount}  Tests: ${total}  ` +
        `${_green}Pass: ${_passCount}${_reset}  ` +
        `${_failCount > 0 ? _red : _green}Fail: ${_failCount}${_reset}`);
    log(`${_bold}═══════════════════════════════════════${_reset}\n`);
    
    if (_isNode) {
        process.exit(_failCount > 0 ? 1 : 0);
    }
    
    return { suites: _suiteCount, pass: _passCount, fail: _failCount };
}
