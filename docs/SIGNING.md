# Firma de código

## Binarios de la app (Authenticode)
Certificado: SSL.com eSigner, `CN=Mateo Piza Ruiz`, thumbprint `F105226E95107920D137D7E761C605F0EF30933B`,
en `Cert:\CurrentUser\My`, válido hasta 2027-09-09. La clave vive en el HSM de SSL.com y se usa a través de
eSigner CKA (ya instalado). No hay `.pfx`: nunca usar `/f` ni `/p`.

```
npm run build:native    # compilar primero: recompilar invalida la firma
npm run sign            # firma lo que no esté firmado por nosotros y verifica con /pa
npm run sign -- --force # re-firma todo
```

**OTP manual:** en esta máquina el modo automático de eSigner CKA no genera el TOTP (su log dice
"invalid Base64 secret", secreto de 6 caracteres: parece un código OTP guardado en lugar del secreto
Base64 que entrega SSL.com). Por eso eSigner abre una ventana por cada firma para escribir el OTP de la
app autenticadora. Hay que tener la app de VOXORA Meet cerrada (un exe en ejecución no se puede firmar)
y estar frente al PC. Para firmar sin intervención, configura en eSigner CKA el secreto TOTP Base64 de
SSL.com (cambio de configuración que decide el titular).

`scripts/sign.mjs` aplica las reglas:
- Firma por thumbprint con `/fd SHA256 /tr http://ts.ssl.com /td SHA256 /sha1 <thumbprint>`.
- Espera 36 s entre firmas (eSigner pide un TOTP por firma) y reintenta ante "The OTP is invalid".
- Solo da por buena una firma si `signtool verify /pa` pasa.
- Orden: helpers, DLL y host de la cámara virtual, y al final `VoxoraMeet.exe`.

Instalador propio (`docs/RELEASE.md`): `npm run release` firma los binarios internos del layout ANTES
de empaquetarlos (`node scripts/sign.mjs --layout dist/VOXORA-Meet-<v>`, incluido
`VoxoraMeetUninstall.exe`; `node\node.exe` conserva la firma de OpenJS) y al final el instalador
(`node scripts/sign.mjs --installer dist/VOXORA-Meet-Setup-<v>.exe`). El actualizador de la app solo
acepta instaladores firmados con este thumbprint (`app/native-shell/src/updater.cpp`): si cambia el
certificado, añade el nuevo thumbprint allí y publica una versión firmada con el viejo antes de rotarlo.

## Driver de kernel (micrófono virtual)
Quien firma el driver es **Microsoft** (firma por atestación en Partner Center); el certificado propio solo
identifica a quien lo envía. Requisitos verificados en la documentación de Microsoft (2026):
- **Registro en el Hardware Developer Program:** exige subir un certificado **EV** Code Signing
  (política `2.23.140.1.3`). El certificado actual es OV (política `2.23.140.1.4.1`), así que no alcanza
  para registrarse.
- **Envíos:** una vez registrada la cuenta con el EV, cada `.cab` puede firmarse con el EV o con otro
  certificado Authenticode registrado en la cuenta, como el OV actual. El EV registrado debe seguir
  vigente al momento de cada envío.
- **Persona natural:** no hace falta constituir empresa. SSL.com vende "EV Code Signing para Sole
  Proprietor" a personas naturales (formulario EV Sole Proprietor firmado + identificación notarizada),
  y en Partner Center se registra la "compañía" con los datos personales (opción "I don't have D-U-N-S number").

Fuentes: learn.microsoft.com/windows-hardware/drivers/dashboard/hardware-program-register y
.../dashboard/code-signing-reqs; ssl.com/products/software-integrity/code-signing/ev-sole-proprietor/.

Pasos:
1. Comprar el EV Sole Proprietor en SSL.com (se puede tener en eSigner igual que el actual).
2. Registrarse en Partner Center → Hardware y subir el EV.
3. Firmar el `.cab` (con el EV o con el OV registrado) y enviarlo: `windows-driver/signing/README.md`.
4. Mientras tanto, VB-Cable como micrófono virtual (la app lo detecta y lo usa automáticamente), y para
   probar el driver propio, una máquina virtual con `testsigning` (ver `windows-driver/README.md`).
