/**
 * EventBus unit tests.
 * Uses eventBus.constructor to create fresh instances (class not exported).
 */
import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';

// Get the EventBus class via the singleton's constructor
const EventBus = eventBus.constructor;

describe('EventBus', () => {
    
    it('on + emit delivers payload', () => {
        const bus = new EventBus();
        let received = null;
        bus.on('test', (data) => { received = data; });
        bus.emit('test', { value: 42 });
        assert.deepEqual(received, { value: 42 });
    });
    
    it('off removes listener', () => {
        const bus = new EventBus();
        let count = 0;
        const handler = () => { count++; };
        bus.on('test', handler);
        bus.emit('test');
        bus.off('test', handler);
        bus.emit('test');
        assert.equal(count, 1);
    });
    
    it('once fires only once', () => {
        const bus = new EventBus();
        let count = 0;
        bus.once('test', () => { count++; });
        bus.emit('test');
        bus.emit('test');
        assert.equal(count, 1);
    });
    
    it('multiple listeners on same event', () => {
        const bus = new EventBus();
        let a = 0, b = 0;
        bus.on('test', () => { a++; });
        bus.on('test', () => { b++; });
        bus.emit('test');
        assert.equal(a, 1);
        assert.equal(b, 1);
    });
    
    it('emit with no listeners does not throw', () => {
        const bus = new EventBus();
        // Should not throw
        bus.emit('nonexistent', { data: true });
        assert.ok(true);
    });
    
    it('clear removes all listeners', () => {
        const bus = new EventBus();
        let count = 0;
        bus.on('a', () => { count++; });
        bus.on('b', () => { count++; });
        bus.clear();
        bus.emit('a');
        bus.emit('b');
        assert.equal(count, 0);
    });
    
    it('clear(event) removes only that event', () => {
        const bus = new EventBus();
        let a = 0, b = 0;
        bus.on('a', () => { a++; });
        bus.on('b', () => { b++; });
        bus.clear('a');
        bus.emit('a');
        bus.emit('b');
        assert.equal(a, 0, 'Event "a" should be cleared');
        assert.equal(b, 1, 'Event "b" should still fire');
    });
    
    it('on() returns unsubscribe function', () => {
        const bus = new EventBus();
        let count = 0;
        const unsub = bus.on('test', () => { count++; });
        bus.emit('test');
        unsub();
        bus.emit('test');
        assert.equal(count, 1, 'Unsubscribe should prevent further calls');
    });
});
