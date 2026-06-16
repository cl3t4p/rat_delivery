/** @typedef {import('../../shared/types.js').ZoneName} ZoneName*/

import { beliefs } from '../beliefs.js';
import { getZone as _sharedGetZone } from '../../shared/zones.js';
import { resetRoamTarget } from '../deliberation.js';


// ── Zone constraint ──────────────────────────────────────────────────────────
// Set by intentionRevision when a ZONE_ASSIGN message is accepted.
// Persists across deliberation cycles so the agent stays in its zone even
// after the one-shot go_to waypoint has been consumed.

/** @type {ZoneName} */
export let _zoneConstraint = null;


/**
 * Persists the zone the agent should prefer for roaming and pickup.
 * Pass null to restore full-map behaviour (no zone preference).
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