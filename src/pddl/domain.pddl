; Deliveroo domain: grid navigation with parcel pickup and delivery.

(define (domain deliveroo)
    (:requirements :strips :negative-preconditions)

    (:predicates
        (tile ?t)
        (delivery ?t)        ; drop-off tile (map type 2)
        (agent ?a)
        (me ?a)
        (parcel ?p)
        (at ?o ?t)           ; agent or parcel ?o is on tile ?t
        (carrying ?a ?p)
        (right ?from ?to)
        (left ?from ?to)
        (up ?from ?to)
        (down ?from ?to)
    )

    (:action move-right
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (right ?from ?to))
        :effect (and (at ?me ?to) (not (at ?me ?from)))
    )
    (:action move-left
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (left ?from ?to))
        :effect (and (at ?me ?to) (not (at ?me ?from)))
    )
    (:action move-up
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (up ?from ?to))
        :effect (and (at ?me ?to) (not (at ?me ?from)))
    )
    (:action move-down
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (down ?from ?to))
        :effect (and (at ?me ?to) (not (at ?me ?from)))
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
