Final L1 font-floor review — bounded improvement, coverage unchanged

The compact title/type collision is absent at inspected 10.0s and outward 19.0–19.5s frames. Expanded label states at 19.75–20.75s are also separated. No new title/description collision was observed; boundary description text is absent in these samples. Evidence: /tmp/floor10.png and /tmp/floor-out-labels.jpg.

The recording starts with the container layout already visible. Its first inward trace frame uses semantic-path:context:system:okie:settled, whereas its endpoint uses semantic-path:context:base:settled at the original camera (-393.525,-452.338,0.8037). This demonstrates a starting/ending scene discrepancy and prevents treating this as an equivalent complete inward L1 morph retest.

44 inputs / 409 frames, no truncation or dropped samples. Split at reversal: 176 inward and 233 outward frames, zero opposite zoom steps in each. This does not prove absence of all geometry jitter. Sampled minimap stays populated; exact alignment is unverified.

The prior three failed matrix cases remain unchanged pending equivalent inward/partial coverage. This records the observed label improvement without erasing failed history or claiming a global pass. Hashes and trace metrics are in final-l1-floor-review.json.
