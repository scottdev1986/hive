# vttest terminal-report qualification

The official vttest 2.7 (20251205) source and locally built executable were
used as the independent report inventory. `vttest-version.txt` pins the
download and its archive hash. The table below maps applicable vttest report
tests to exact live records in `live-proof.jsonl`; it does not treat parser
support or a rendered screen as proof of a host reply.

`vttest-terminal-reports.bin` is the raw interactive vttest session produced
by `vttest-report-driver.exp`. The driver injects the same fixed replies used
as the independent expectations in the live probe, allowing vttest to classify
them. `vttest-session-summary.txt` extracts the results. This is deliberately
separate from the delivery proof: only `live-proof.jsonl` establishes that the
real Ghostty write callback produced each byte string exactly once and in
order.

| vttest menu/test | Query | Exact live callback | Result |
| --- | --- | --- | --- |
| Test of terminal reports → Device Status Report | `CSI 5 n` | `CSI 0 n` | PASS, one callback |
| Test of terminal reports → Device Status Report | cursor move + `CSI 6 n` | `CSI 3 ; 7 R` | PASS, one callback |
| Test of terminal reports → Device Status Report, vttest coordinate | move to 5,1 + `CSI 6 n` | `CSI 5 ; 1 R` | PASS, one callback |
| Test of terminal reports → Primary Device Attributes | `CSI c` | `CSI ? 62 ; 22 c` | PASS, one callback |
| Test of terminal reports → Secondary Device Attributes | `CSI > c` | `CSI > 1 ; 10 ; 0 c` | PASS, one callback |
| Test of terminal reports → Tertiary Device Attributes | `CSI = c` | `DCS ! | 00000000 ST` | PASS, one callback |
| XTERM miscellaneous reports → Report version | `CSI > q` | `DCS > | ghostty 1.3.2-hive-florence-category-complex-coding-m1-b1-+a07b570d ST` | PASS, one callback |
| XTERM miscellaneous reports → Report version, zero parameter | `CSI > 0 q` from Claude startup | same XTVERSION bytes | PASS, one callback |
| XTERM/VT520 Status-String Report | `DCS $ q m ST` | `DCS 1 $ r 0 m ST` | PASS, one callback |
| Test of terminal reports → ENQ AnswerBack | `ENQ` | configured empty answerback, no reply | POLICY PASS, zero callbacks plus live DA1 control |

vttest's main menu labels “Test of terminal reports” in `main.c`; its report
menu in `reports.c` emits ENQ, DSR, DA1, DA2, and DA3. Its XTERM reports menu
in `xterm.c` emits both `CSI > q` and `CSI > 0 q` and exercises DECRQSS. Those
emitted control forms were fed to the real manual surface. The raw callback
bytes—not vttest's human-readable classification—are the acceptance oracle.

Additional xterm/Ghostty negotiation coverage in the same live corpus includes
DECRQM (known and unknown modes), XTGETTCAP, three window-size forms, title,
xterm palette and dynamic colors, kitty color and keyboard protocols, the
glyph protocol, and a kitty-graphics acknowledgement.
