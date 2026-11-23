// Vendor trust anchors for the `hardware` approval key policy. Pinned in the binary: nothing is
// fetched at runtime. An operator who needs another vendor adds custom AAGUIDs for devices whose
// attestation chains to a root listed here; adding a root means a code change and a release.
//
// Source: https://developers.yubico.com/PKI/yubico-ca-certs.txt (updated 2025-02-03) and
// https://developers.yubico.com/PKI/yubico-intermediate.pem, fetched 2026-11-23. Before relying on
// this, note that all five certificates also appear as Yubico attestation roots in the FIDO
// Alliance MDS3 blob (no. 303), an independent second source (checked 2026-11-23).
// The AAGUID preset comes from the community list at
// https://github.com/passkeydeveloper/passkey-authenticator-aaguids (names starting "YubiKey 5"
// or "YubiKey Bio", without Preview, RC and Enterprise Profile entries, which are per-customer).

export type PinnedCert = { name: string; pem: string };

export const VENDOR_ROOTS: readonly PinnedCert[] = [
  // sha256 0F:A1:38:6F:80:EB:87:13:26:3A:E5:C1:D8:4D:EB:45:5B:DF:08:AE:A5:0A:B0:55:03:CE:FE:E8:2B:09:2D:42
  {
    name: "Yubico U2F Root CA Serial 457200631",
    pem: `-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIEG0BT9zANBgkqhkiG9w0BAQsFADAuMSwwKgYDVQQDEyNZ
dWJpY28gVTJGIFJvb3QgQ0EgU2VyaWFsIDQ1NzIwMDYzMTAgFw0xNDA4MDEwMDAw
MDBaGA8yMDUwMDkwNDAwMDAwMFowLjEsMCoGA1UEAxMjWXViaWNvIFUyRiBSb290
IENBIFNlcmlhbCA0NTcyMDA2MzEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQC/jwYuhBVlqaiYWEMsrWFisgJ+PtM91eSrpI4TK7U53mwCIawSDHy8vUmk
5N2KAj9abvT9NP5SMS1hQi3usxoYGonXQgfO6ZXyUA9a+KAkqdFnBnlyugSeCOep
8EdZFfsaRFtMjkwz5Gcz2Py4vIYvCdMHPtwaz0bVuzneueIEz6TnQjE63Rdt2zbw
nebwTG5ZybeWSwbzy+BJ34ZHcUhPAY89yJQXuE0IzMZFcEBbPNRbWECRKgjq//qT
9nmDOFVlSRCt2wiqPSzluwn+v+suQEBsUjTGMEd25tKXXTkNW21wIWbxeSyUoTXw
LvGS6xlwQSgNpk2qXYwf8iXg7VWZAgMBAAGjQjBAMB0GA1UdDgQWBBQgIvz0bNGJ
hjgpToksyKpP9xv9oDAPBgNVHRMECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAN
BgkqhkiG9w0BAQsFAAOCAQEAjvjuOMDSa+JXFCLyBKsycXtBVZsJ4Ue3LbaEsPY4
MYN/hIQ5ZM5p7EjfcnMG4CtYkNsfNHc0AhBLdq45rnT87q/6O3vUEtNMafbhU6kt
hX7Y+9XFN9NpmYxr+ekVY5xOxi8h9JDIgoMP4VB1uS0aunL1IGqrNooL9mmFnL2k
LVVee6/VR6C5+KSTCMCWppMuJIZII2v9o4dkoZ8Y7QRjQlLfYzd3qGtKbw7xaF1U
sG/5xUb/Btwb2X2g4InpiB/yt/3CpQXpiWX/K4mBvUKiGn05ZsqeY1gx4g0xLBqc
U9psmyPzK+Vsgw2jeRQ5JlKDyqE0hebfC1tvFu0CCrJFcw==
-----END CERTIFICATE-----
`,
  },
  // sha256 35:F1:A5:4B:35:3B:FB:71:1E:6D:42:AD:BE:B7:6C:0E:9D:EA:D0:95:01:8E:6A:94:78:3B:A2:19:2F:D6:FA:AD
  {
    name: "Yubico FIDO Root CA Serial 450203556",
    pem: `-----BEGIN CERTIFICATE-----
MIIDMzCCAhugAwIBAgIUSOEjTf//yqRfPW7Qq8qtIyCrAg8wDQYJKoZIhvcNAQEL
BQAwLzEtMCsGA1UEAwwkWXViaWNvIEZJRE8gUm9vdCBDQSBTZXJpYWwgNDUwMjAz
NTU2MCAXDTI0MDUwMTAwMDAwMFoYDzIwNjAwNDMwMDAwMDAwWjAvMS0wKwYDVQQD
DCRZdWJpY28gRklETyBSb290IENBIFNlcmlhbCA0NTAyMDM1NTYwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCdvl27w2gu1fPXeEFbIdqx0BalvVDVWrQP
J7HqviuEtZHlxSLxSFtcXpTolvLvof8f4tMerQTkVGzcmYzm1EBT4IJuMmoEqfkE
EhWpsADMFrjZkqlZY9EqxQzLoVEEonE5oGxSdVCxCcLIackpyR/CCXvj1Bt/hTgE
9hTlF4pRqxMkx3plF7y8dDZlRHWs7vbnhmBCGeI0ZPEQ6nl2mCg2r74adF2u6K9r
rLfhBC3QLE8EPrgqUsI+hkuq2tK4M2SMOp8uUVVkqUeu3h0kr3WVI0W02pkgrOgi
FKLFNkSrbYhdjMBDj5izmqfc9xJRKoDX612qd8ZGVHpT5AYFX+1hAgMBAAGjRTBD
MB0GA1UdDgQWBBTZyU5DiQ/a2UEgE7qBK0zhIsRNRjASBgNVHRMBAf8ECDAGAQH/
AgEAMA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAQEAXvnB4SLuUJfY
MSVGAhssL/SmWli3FSccgxydvKlACcidIIWKQqa3q/QSUEQzC9DgEfMgr7iC1BkT
ZbILboV6UZ5knNsvjEZWuMeogJ8tgZs1hVvKwZizwJ+mEcmsjhIrBYuoL1T6yrOJ
vKFg1jv+Cy4ZwA9Bpk/V3UOir1VyK8dCtyHu6vfosotAdYx8FAuR243gRTMV6Jx8
Jdig2JDIAQMlzVeDpSUHX/K2HXRHxHwfgjbgUjjBu/72r8OfehyhzHXI3K8CFFdf
lO+8nEOJK3y8F1ivgS5uN/8SmcYw/STQYwhrxPuwz3nP8baMum4BB2nnYmpB60sX
3bl5k8QUSw==
-----END CERTIFICATE-----
`,
  },
  // sha256 62:76:0C:6A:6E:F9:16:79:F4:54:C8:90:2B:80:FD:00:98:25:B3:F2:5D:A9:0F:1F:BA:CE:2E:C6:58:6C:D5:A8
  {
    name: "Yubico Attestation Root 1",
    pem: `-----BEGIN CERTIFICATE-----
MIIDPjCCAiagAwIBAgIUXzeiEDJEOTt14F5n0o6Zf/bBwiUwDQYJKoZIhvcNAQEN
BQAwJDEiMCAGA1UEAwwZWXViaWNvIEF0dGVzdGF0aW9uIFJvb3QgMTAgFw0yNDEy
MDEwMDAwMDBaGA85OTk5MTIzMTIzNTk1OVowJDEiMCAGA1UEAwwZWXViaWNvIEF0
dGVzdGF0aW9uIFJvb3QgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AMZ6/TxM8rIT+EaoPvG81ontMOo/2mQ2RBwJHS0QZcxVaNXvl12LUhBZ5LmiBScI
Zd1Rnx1od585h+/dhK7hEm7JAALkKKts1fO53KGNLZujz5h3wGncr4hyKF0G74b/
U3K9hE5mGND6zqYchCRAHfrYMYRDF4YL0X4D5nGdxvppAy6nkEmtWmMnwO3i0TAu
csrbE485HvGM4r0VpgVdJpvgQjiTJCTIq+D35hwtT8QDIv+nGvpcyi5wcIfCkzyC
imJukhYy6KoqNMKQEdpNiSOvWyDMTMt1bwCvEzpw91u+msUt4rj0efnO9s0ZOwdw
MRDnH4xgUl5ZLwrrPkfC1/0CAwEAAaNmMGQwHQYDVR0OBBYEFNLu71oijTptXCOX
PfKF1SbxJXuSMB8GA1UdIwQYMBaAFNLu71oijTptXCOXPfKF1SbxJXuSMBIGA1Ud
EwEB/wQIMAYBAf8CAQMwDgYDVR0PAQH/BAQDAgGGMA0GCSqGSIb3DQEBDQUAA4IB
AQC3IW/sgB9pZ8apJNjxuGoX+FkILks0wMNrdXL/coUvsrhzsvl6mePMrbGJByJ1
XnquB5sgcRENFxdQFma3mio8Upf1owM1ZreXrJ0mADG2BplqbJnxiyYa+R11reIF
TWeIhMNcZKsDZrFAyPuFjCWSQvJmNWe9mFRYFgNhXJKkXIb5H1XgEDlwiedYRM7V
olBNlld6pRFKlX8ust6OTMOeADl2xNF0m1LThSdeuXvDyC1g9+ILfz3S6OIYgc3i
roRcFD354g7rKfu67qFAw9gC4yi0xBTPrY95rh4/HqaUYCA/L8ldRk6H7Xk35D+W
Vpmq2Sh/xT5HiFuhf4wJb0bK
-----END CERTIFICATE-----
`,
  },
];

/** Intermediates the device may not send. Untrusted: a chain must still end in a root above. */
export const VENDOR_INTERMEDIATES: readonly PinnedCert[] = [
  {
    name: "Yubico Attestation Intermediate A 1",
    pem: `-----BEGIN CERTIFICATE-----
MIIDSDCCAjCgAwIBAgIUUcmMXzRIFOgGTK0Tb3gEuZYZkBIwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZWXViaWNvIEF0dGVzdGF0aW9uIFJvb3QgMTAgFw0yNDEy
MDEwMDAwMDBaGA85OTk5MTIzMTIzNTk1OVowLjEsMCoGA1UEAwwjWXViaWNvIEF0
dGVzdGF0aW9uIEludGVybWVkaWF0ZSBBIDEwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQDm555bWY9WW+tOY0rIWHldh+aNanoCZCFh7Gk3YZrQmPUw0hkS
G6qYHQtP+fZyS33VErvg+BQqnmumgNhfxFrkwEZELeidBcC8C4Ag4nqqiPWpzsvI
17NcxYlInLNLFcZY/+gOiN6ZOTihO5/vBZMbj9riaAcqliYmNGJPgTcMGaEAyMzE
MNy2nm6Ep+pjP5aF6gi21t/UQFsuJ1j2Rj/ynM/SdRt+ecal5OYotxHkFbL9vvv2
A2Ov5ITZClw4bOS9npypQimOZ5QAYytmYaQpWl/pMYz6zSj8RqkVDNEJGqNfTKA2
ivLYwX6lSttMPapg0J84l9X0voVN/FpS4VCVAgMBAAGjZjBkMB0GA1UdDgQWBBQg
KFAhG6RaW+hTy52dxeT8bC96HzAfBgNVHSMEGDAWgBTS7u9aIo06bVwjlz3yhdUm
8SV7kjASBgNVHRMBAf8ECDAGAQH/AgECMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG
9w0BAQsFAAOCAQEAYMzgLrJLIr0OovQnAZrRIGuabiHSUKSmbLRWpRkWeAtsChDE
HpXcJ/bgDNKYWoHqQ8xRUjB4CyepYevc3YlrG8o7zHxpfVcaoL5SeuJkzHxKn4bT
aSp9+Mvwamnp64kZMiNbFLknfP9kYKoRHkMWheRJ1UsP1z4ScmkCeILfsMs6vqov
qjWClFsJpBcsluYHWF7bBJ1n4Rwg+ATEopY4IgGv6Zvwc+A9r+AT2hqpoSkYoAl+
ANYwgslOf9sJe0V+TA9YY/UlaBmPPTd0//r9wvcePWZkPjKoAC/zUNhfDbh4LV8G
Hs3lyX2XomL/LNc8JYzyIaDEhGQveoPhh/tr1g==
-----END CERTIFICATE-----
`,
  },
  {
    name: "Yubico Attestation Intermediate B 1",
    pem: `-----BEGIN CERTIFICATE-----
MIIDSDCCAjCgAwIBAgIUDqERw+4RnGSggxgUewJFEPDRZ3YwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZWXViaWNvIEF0dGVzdGF0aW9uIFJvb3QgMTAgFw0yNDEy
MDEwMDAwMDBaGA85OTk5MTIzMTIzNTk1OVowLjEsMCoGA1UEAwwjWXViaWNvIEF0
dGVzdGF0aW9uIEludGVybWVkaWF0ZSBCIDEwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQDI7XnH+ZvDwMCQU8M8ZeV5qscublvVYaaRt3Ybaxn9godLx5sw
H0lXrdgjh5h7FpVgCgYYX7E4bl1vbzULemrMWT8N3WMGUe8QAJbBeioV7W/E+hTZ
P/0SKJVa3ewKBo6ULeMnfQZDrVORAk8wTLq2v5Llj5vMj7JtOotKa9J7nHS8kLmz
XXSaj0SwEPh5OAZUTNV4zs1bvoTAQQWrL4/J9QuKt6WCFE5nUNiRQcEbVF8mlqK2
bx2z6okVltyDVLCxYbpUTELvY1usR3DTGPUoIClOm4crpwnDRLVHvjYePGBB//pE
yzxA/gcScxjwaH1ZUw9bnSbHyurKqbTa1KvjAgMBAAGjZjBkMB0GA1UdDgQWBBTq
t0KQngx7ZHrbVHwDunxOn9ihYTAfBgNVHSMEGDAWgBTS7u9aIo06bVwjlz3yhdUm
8SV7kjASBgNVHRMBAf8ECDAGAQH/AgECMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG
9w0BAQsFAAOCAQEAqQaCWMxTGqVVX7Sk7kkJmUueTSYKuU6+KBBSgwIRnlw9K7He
1IpxZ0hdwpPNikKjmcyFgFPzhImwHJgxxuT90Pw3vYOdcJJNktDg35PXOfzSn15c
FAx1RO0mPTmIb8dXiEWOpzoXvdwXDM41ZaCDYMT7w4IQtMyvE7xUBZq2bjtAnq/N
DUA7be4H8H3ipC+/+NKlUrcUh+j48K67WI0u1m6FeQueBA7n06j825rqDqsaLs9T
b7KAHAw8PmrWaNPG2kjKerxPEfecivlFawp2RWZvxrVtn3TV2SBxyCJCkXsND05d
CErVHSJIs+BdtTVNY9AwtyPmnyb0v4mSTzvWdw==
-----END CERTIFICATE-----
`,
  },
];

/** AAGUID presets for the org allowlist. */
export const AAGUID_PRESETS: Readonly<Record<string, readonly string[]>> = {
  yubikey: [
    "03012cb7-4fb2-42e7-9e8d-a81f10e2a5e9",
    "0a357157-9b18-4c8a-920e-d156e972b2f8",
    "0ebd9f2c-f685-441c-8c3e-a02a234a840a",
    "19083c3d-8383-4b18-bc03-8f1c9ab2fd1b",
    "24673149-6c86-42e7-98d9-433fb5b73296",
    "2fc0579f-8113-47ea-b116-bb5a8db9202a",
    "34744913-4f57-4e6e-a527-e9ec3c4b94e6",
    "3aa78eb1-ddd8-46a8-a821-8f8ec57a7bd5",
    "57f7de54-c807-4eab-b1c6-1c9be7984e92",
    "58276709-bb4b-4bb3-baf1-60eea99282a7",
    "662ef48a-95e2-4aaa-a6c1-5b9c40375824",
    "73bb0cd4-e502-49b8-9c6f-b59445bf720b",
    "7409272d-1ff9-4e10-9fc9-ac0019c124fd",
    "7b96457d-e3cd-432b-9ceb-c9fdd7ef7432",
    "7d1351a6-e097-4852-b8bf-c9ac5c9ce4a3",
    "7dab85a5-d16d-4eaf-a7ef-4c1385b151c5",
    "85203421-48f9-4355-9bc8-8a53846e5083",
    "90636e1f-ef82-43bf-bdcf-5255f139d12f",
    "9806a2c8-c0da-478e-b4ca-620005d34182",
    "9dd8d593-2213-438a-97f8-d6b813d51c27",
    "9eb7eabc-9db5-49a1-b6c3-555a802093f4",
    "a02167b9-ae71-4ac7-9a07-06432ebb6f1c",
    "a25342c0-3cdc-4414-8e46-f4807fca511c",
    "ba0a9266-40d8-4048-9786-d710b5474752",
    "c1f9a0bc-1dd2-404a-b27f-8e29047a43fd",
    "c5ef55ff-ad9a-4b9f-b580-adebafe026d0",
    "cb69481e-8ff7-4039-93ec-0a2729a154a8",
    "d7781e5d-e353-46aa-afe2-3ca49f13332a",
    "d8522d9f-575b-4866-88a9-ba99fa02f35b",
    "dd86a2da-86a0-4cbe-b462-4bd31f57bc6f",
    "eb7ef748-cbe0-4b40-b8f6-07bd2d592d35",
    "ee882879-721c-4913-9775-3dfcce97072a",
    "f4ce5fc0-57d3-46f5-a736-efb7d5bc63b5",
    "fa2b99dc-9e39-4257-8f92-4a30d23c4118",
    "fcc0118f-cd45-435b-8da1-9782b2da0715",
    "ff4dac45-ede8-4ec2-aced-cf66103f4335",
  ],
};
