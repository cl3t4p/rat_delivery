; Domain file per Deliveroo.js
; Modella le azioni di un agente che raccoglie e consegna pacchi su una griglia

(define (domain deliveroo)
    (:requirements :strips) ; :strips = azioni con predizioni ed effetti semplici (aggiungi/rimuovi fatti)

    ; I predicati sono i "fatti" che descrivono lo stato del mondo
    ; Possono essere veri o falsi in ogni momento
    (:predicates
        (tile ?t)                   ; ?t è una tile della mappa
        (delivery ?t)               ; ?t è una zona di consegna (tipo '2')
        (agent ?a)                  ; ?a è un agente
        (parcel ?p)                 ; ?p è un pacco
        (me ?a)                     ; ?a è il nostro agente (non un avversario)
        (at ?agentOrParcel ?t)      ; l'agente o il pacco si trova sulla tile ?t
        (right ?t1 ?t2)             ; dalla tile ?t1 puoi andare a destra verso ?t2
        (left ?t1 ?t2)              ; dalla tile ?t1 puoi andare a sinistra verso ?t2
        (up ?t1 ?t2)                ; dalla tile ?t1 puoi andare in su verso ?t2
        (down ?t1 ?t2)              ; dalla tile ?t1 puoi andare in giù verso ?t2
        (carrying ?a ?p)            ; l'agente ?a sta portando il pacco ?p
    )

    ; ––– AZIONI ––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
    ; Un'azione ha sempre:
    ;   :parameters -> gli oggetti coinvolti
    ;   :precondition -> cosa deve essere VERO prima di eseguirla
    ;   :effect -> cosa cambia DOPO averla eseguita

    ; Sposta l'agente di una tile verso destra
    (:action move-right
        :parameters (?me ?from ?to)
        :precondition (and 
            (me ?me)                ; ?me è il nostro agente
            (at ?me ?from)          ; l'agente è sulla tile ?from
            (right ?from ?to)       ; ?to è la tile a destra di ?from
        )
        :effect (and 
            (at ?me ?to)            ; ora l'agente è su ?to
            (not (at ?me ?from))    ; non è più su ?from
        )
    )

    ; Sposta l'agente di una tile verso sinistra
    (:action move-left
        :parameters (?me ?from ?to)
        :precondition (and
            (me ?me)                ; ?me è il nostro agente
            (at ?me ?from)          ; l'agente è sulla tile ?from
            (left ?from ?to)        ; ?to è la tile a sinistra di ?from
        )
        :effect (and
            (at ?me ?to)            ; ora l'agente è su ?to
            (not (at ?me ?from))    ; non è più su ?from
        )
    )

    ; Sposta l'agente di una tile verso su
    (:action move-up
        :parameters (?me ?from ?to)
        :precondition (and
            (me ?me)                ; ?me è il nostro agente
            (at ?me ?from)          ; l'agente è sulla tile ?from
            (up ?from ?to)          ; ?to è la tile sopra ?from
        )
        :effect (and
            (at ?me ?to)            ; ora l'agente è su ?to
            (not (at ?me ?from))    ; non è più su ?from
        )
    )

    ; Sposta l'agente di una tile verso giù
    (:action move-down
        :parameters (?me ?from ?to)
        :precondition (and
            (me ?me)                ; ?me è il nostro agente
            (at ?me ?from)          ; l'agente è sulla tile ?from
            (down ?from ?to)        ; ?to è la tile sotto ?from
        )
        :effect (and
            (at ?me ?to)            ; ora l'agente è su ?to
            (not (at ?me ?from))    ; non è più su ?from
        )
    )

    ; Azione pick-up: raccoglie un pacco sulla tile dove si trova l'agente
    (:action pick-up
        :parameters (?me ?p ?t)
        :precondition (and 
            (me ?me)                ; ?me è il nostro agente
            (at ?me ?t)             ; l'agente è sulla tile ?t
            (parcel ?p)             ; ?p è un pacco
            (at ?p ?t)              ; il pacco è sulla stessa tile dell'agente
        )
        :effect (and 
            (carrying ?me ?p)       ; ora l'agente porta il pacco
            (not (at ?p ?t))        ; il pacco non è più sulla tile
        )
    )

    ; Azione put-down: consegna un pacco su una tile di consegna
    (:action put-down
        :parameters (?me ?p ?t)
        :precondition (and
            (me ?me)                ; ?me è il nostro agente
            (at ?me ?t)             ; l'agente è sulla tile ?t
            (carrying ?me ?p)       ; l'agente sta portando il pacco ?p
            (delivery ?t)           ; la tile è una zona di consegna
        )
        :effect (and
            (not (carrying ?me ?p)) ; l'agente non porta più il pacco
        )
    )
)