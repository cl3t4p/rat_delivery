import assert from 'node:assert/strict';

import { beliefs } from '../src/bdi/beliefs.js';
import {
    estimateDecay,
    estimatedRewardAtDelivery,
    pickupValue,
    deliveryValue,
    detourValue,
} from '../src/bdi/scoring.js';

function resetBeliefs() {
    beliefs.parcels.clear();
    beliefs.deliveryTiles = [];
    beliefs.config.PARCEL_DECADING_INTERVAL = 1000;
    beliefs.config.MS_PER_STEP = 1000;
    beliefs.me.carrying = [];
}

function addParcel(id, x, y, reward, carriedBy = null) {
    beliefs.parcels.set(id, {
        id,
        x,
        y,
        reward,
        carriedBy,
        lastSeen: Date.now(),
    });
}

resetBeliefs();

// estimateDecay / estimatedRewardAtDelivery
assert.equal(estimateDecay(3), 3);
assert.equal(estimatedRewardAtDelivery(10, 3), 7);
assert.equal(estimatedRewardAtDelivery(2, 5), 0);

// pickupValue considers parcel -> delivery distance
resetBeliefs();
const myPos = { x: 0, y: 0 };
const delivery = { x: 10, y: 0 };
const parcel = { id: 'p1', x: 1, y: 0, reward: 20 };

assert.equal(pickupValue(parcel, myPos, delivery), 0);
// Explanation:
// dist me->parcel = 1
// dist parcel->delivery = 9
// totalSteps = 10
// rewardAtDelivery = 10
// score = 10 - 10 = 0

// deliveryValue uses estimated reward at arrival
resetBeliefs();
beliefs.me.id = 'me';
beliefs.me.carrying = ['c1', 'c2'];
addParcel('c1', 0, 0, 10, 'me');
addParcel('c2', 0, 0, 5, 'me');

assert.equal(deliveryValue(['c1', 'c2'], { x: 0, y: 0 }, { x: 3, y: 0 }), 9);
// c1: 10 - 3 = 7
// c2: 5 - 3 = 2
// total = 9

// detour rejected when carried parcels lose too much
resetBeliefs();
beliefs.me.id = 'me';
beliefs.me.carrying = ['c1'];
addParcel('c1', 0, 0, 10, 'me');

const weakParcel = { id: 'p2', x: 5, y: 0, reward: 3 };
const delivery2 = { x: 6, y: 0 };

assert.ok(detourValue(weakParcel, { x: 0, y: 0 }, ['c1'], delivery2) <= 0);

// detour accepted when new parcel compensates
resetBeliefs();
beliefs.me.id = 'me';
beliefs.me.carrying = ['c1'];
addParcel('c1', 0, 0, 20, 'me');

const strongParcel = { id: 'p3', x: 1, y: 0, reward: 20 };
const delivery3 = { x: 2, y: 0 };

assert.ok(detourValue(strongParcel, { x: 0, y: 0 }, ['c1'], delivery3) > 0);

console.log('scoring tests passed');