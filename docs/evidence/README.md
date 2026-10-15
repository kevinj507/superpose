# Recorded evidence

These files are selected, credential-free receipts for judges and agents. Pilot summaries retain the original delivered check results and a SHA-256 of their original local results file; they are not rewritten by later fixes. They omit private transcripts, operator paths and credentials. See [the root README](../../README.md) and the [experiment reports](../experiments/) for design and limits.

- [Runtime pilot](runtime-pilot.json): 8/11, 8/11, 10/11.
- [Discovery pilot](discovery-pilot.json): 11/11, 11/11, 5/11.
- [Scripted recovery](scripted-recovery.json): 11/11 product checks after normal worker and unchanged CSV delivery.
- [Fresh production recovery](production-recovery.json): 11/11 product checks after deployment, 159 seconds, zero model calls.
- [Prose completion qualification](prose-completion-qualification.json): 20/20 mechanism checks and three actual landings, zero model calls.
- [First qualification startup failure](prose-completion-startup-failure.json): the preceding sandbox attempt stopped at executor initialization after three checks. It was not a pass.

A checksum identifies the preserved local source; it is not an independent attestation. Model results, scripted lifecycle checks and product assertions answer different questions. The prose qualification commits scoped comments; it verifies completion, not new model-generated functionality.
