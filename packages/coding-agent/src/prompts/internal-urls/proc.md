`proc://`: jobs/services; `proc://<id>` status/output; write sends stdin (empty = Enter); `proc://<id>/kill` cancels/stops, omit `content`; `proc://<id>/mode`: `persist`|`session`|`detached`.

Mode changes preserve the running process and its input/output. `detached` survives session exit; explicit project-broker shutdown ends services using its live pipes or PTY.
