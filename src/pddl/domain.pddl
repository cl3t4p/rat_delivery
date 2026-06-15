; Deliveroo domain: grid navigation with parcel pickup/delivery and Sokoban-style
; crate pushing. Designed for a single agent (no opponents in the problem).
;
; Crates are movable obstacles: the agent cannot walk through a crate, it can only
; push it by stepping into it, which shoves the crate one tile further in the same
; direction. A push is only legal when the tile beyond the crate is free AND is a
; crate-slot (map type 5 sliding tile or 5! spawner) — crates can only rest on those.
; To clear a crate out of the way the planner therefore has to walk *around* it first
; so it approaches from the correct side; this falls out naturally from the preconditions.

(define (domain deliveroo)
    (:requirements :strips :negative-preconditions)

    (:predicates
        (tile ?t)
        (delivery ?t)        ; drop-off tile (map type 2)
        (agent ?a)
        (me ?a)
        (parcel ?p)
        (crate ?c)
        (at ?o ?t)           ; agent, parcel or crate ?o is on tile ?t
        (carrying ?a ?p)
        (occupied ?t)        ; a crate currently sits on tile ?t
        (crate-slot ?t)      ; tile a crate may rest on (map type 5 / 5!)
        (right ?from ?to)
        (left ?from ?to)
        (up ?from ?to)
        (down ?from ?to)
    )

    ; --- plain moves: only onto a tile that is not blocked by a crate ---
    (:action move-right
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (right ?from ?to) (not (occupied ?to)))
        :effect (and (at ?me ?to) (not (at ?me ?from)))
    )
    (:action move-left
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (left ?from ?to) (not (occupied ?to)))
        :effect (and (at ?me ?to) (not (at ?me ?from)))
    )
    (:action move-up
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (up ?from ?to) (not (occupied ?to)))
        :effect (and (at ?me ?to) (not (at ?me ?from)))
    )
    (:action move-down
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (down ?from ?to) (not (occupied ?to)))
        :effect (and (at ?me ?to) (not (at ?me ?from)))
    )

    ; --- pushes: agent at ?from steps into the crate on ?mid, shoving it to ?to ---
    ; ?to must exist (the edge ?mid->?to is only present for real tiles) and be free.
    (:action push-right
        :parameters (?me ?c ?from ?mid ?to)
        :precondition (and (me ?me) (at ?me ?from)
                           (crate ?c) (at ?c ?mid) (occupied ?mid)
                           (right ?from ?mid) (right ?mid ?to)
                           (crate-slot ?to) (not (occupied ?to)))
        :effect (and (at ?me ?mid) (not (at ?me ?from))
                     (at ?c ?to) (not (at ?c ?mid))
                     (occupied ?to) (not (occupied ?mid)))
    )
    (:action push-left
        :parameters (?me ?c ?from ?mid ?to)
        :precondition (and (me ?me) (at ?me ?from)
                           (crate ?c) (at ?c ?mid) (occupied ?mid)
                           (left ?from ?mid) (left ?mid ?to)
                           (crate-slot ?to) (not (occupied ?to)))
        :effect (and (at ?me ?mid) (not (at ?me ?from))
                     (at ?c ?to) (not (at ?c ?mid))
                     (occupied ?to) (not (occupied ?mid)))
    )
    (:action push-up
        :parameters (?me ?c ?from ?mid ?to)
        :precondition (and (me ?me) (at ?me ?from)
                           (crate ?c) (at ?c ?mid) (occupied ?mid)
                           (up ?from ?mid) (up ?mid ?to)
                           (crate-slot ?to) (not (occupied ?to)))
        :effect (and (at ?me ?mid) (not (at ?me ?from))
                     (at ?c ?to) (not (at ?c ?mid))
                     (occupied ?to) (not (occupied ?mid)))
    )
    (:action push-down
        :parameters (?me ?c ?from ?mid ?to)
        :precondition (and (me ?me) (at ?me ?from)
                           (crate ?c) (at ?c ?mid) (occupied ?mid)
                           (down ?from ?mid) (down ?mid ?to)
                           (crate-slot ?to) (not (occupied ?to)))
        :effect (and (at ?me ?mid) (not (at ?me ?from))
                     (at ?c ?to) (not (at ?c ?mid))
                     (occupied ?to) (not (occupied ?mid)))
    )

    (:action pick-up
        :parameters (?me ?p ?t)
        :precondition (and (me ?me) (at ?me ?t) (parcel ?p) (at ?p ?t))
        :effect (and (carrying ?me ?p) (not (at ?p ?t)))
    )

    (:action put-down
        :parameters (?me ?p ?t)
        :precondition (and (me ?me) (at ?me ?t) (carrying ?me ?p) (delivery ?t))
        :effect (and (not (carrying ?me ?p)) (at ?p ?t))
    )
)
