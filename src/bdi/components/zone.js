/** @typedef {import('../../shared/types.js').ZoneName} ZoneName */

import { beliefs } from '../beliefs.js';
import { getZone as _sharedGetZone } from '../../shared/zones.js';
import { resetRoamTarget } from '../deliberation.js';

// Current zone preference for deliberation.

/** @type {ZoneName} */
export let _zoneConstraint = null;

/**
 * Sets the preferred zone for roaming and pickup.
 *
 * @param {ZoneName} zoneName
 */
export function setZoneConstraint(zoneName) {
    if (_zoneConstraint !== zoneName) resetRoamTarget();
    _zoneConstraint = zoneName;
    if (zoneName) console.log(`[deliberation] Zone constraint set: ${zoneName}`);
}

/** True if pos is inside the assigned zone, or no zone constraint is active. */
export function _isInZone(pos) {
    return !_zoneConstraint || _sharedGetZone(pos, beliefs.grid) === _zoneConstraint;
}

export function _matchesZoneOpportunity(parcelPos, deliveryTile) {
    if (!_zoneConstraint) return true;
    return _isInZone(parcelPos) || (deliveryTile && _isInZone(deliveryTile));
}
