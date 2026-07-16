# Bundled diagram fonts

Okie renders diagram text with IBM Plex Sans and L4 code/path text with IBM
Plex Mono. Browser WOFF2 assets come from pinned `@fontsource/ibm-plex-sans`
5.2.8 and `@fontsource/ibm-plex-mono` 5.2.7 packages.

The GPU atlas uses the five static TTFs under `ibm-plex-v6.4.2/`, vendored from
official IBM/plex commit `242c4cccd37e87985a5337815c99b960ef13c65c` (tag
v6.4.2). `LICENSE-IBM-Plex-OFL-1.1.txt` applies to those files. Expected SHA-256:

- Sans Regular: `975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5`
- Sans Medium: `331c8639d7598b2cde62a911a71db195e30cb655cd6bdf2e324a7e984955f907`
- Sans SemiBold: `a20caf8286023a6a7a85e40b1d2a4ae9fc3e3b1f9eda8f4c542dd4986af67bb1`
- Mono Regular: `fe11304a5fe956d5744e9b6a246cc83d90425245e75a62230044966ca96a7f50`
- Mono SemiBold: `c9417148ce13f8fa7d2d5c9180bbc141f72aa0d814ffeb280f6904dc2b1bbd7a`
