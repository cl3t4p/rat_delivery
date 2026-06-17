; Deliveroo domain for single-agent navigation, pickup, delivery and crate pushing.
;
; Crates are movable obstacles. The agent pushes a crate by stepping into it.
; A push is legal only when the tile beyond the crate is free and is a crate slot.

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

    ; Plain moves, only onto tiles not blocked by crates.
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

    ; Pushes move the crate from ?mid to ?to.
    ; ?to must exist and be free.
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
