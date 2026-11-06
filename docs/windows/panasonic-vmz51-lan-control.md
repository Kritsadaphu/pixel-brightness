# Panasonic PT-VMZ51 LAN control

Pixel Brightness controls the five PT-VMZ51 projectors directly from Pixel
Server over the isolated show LAN. This path is independent of video:

```text
Resolume / NDI -> Magewell decoder -> HDMI -> PT-VMZ51
Pixel Control page -> Pixel Server -> Panasonic NTCONTROL TCP/1024 -> PT-VMZ51
```

PJLink is not used. The browser never connects to TCP port 1024 itself and
never receives the projector password. It sends an allowlisted logical action
to Pixel Server, which resolves the projector's saved IP address and sends one
Panasonic native LAN command.

## Projector menu setup

Configure a fixed, unique IP address for every projector. On each PT-VMZ51:

1. Set/confirm **Network > Administrator Account** for the manufacturer's Web
   Control page. The default administrator username is `dispadmin`.
2. Set **Network > Network Control > Command Control** to **On**.
3. Set **Network > Network Control > Web Control** to **On** if the per-device
   browser link will be used.
4. Leave **Command Port** at `1024` unless the site requires another port.
5. On this isolated offline show LAN, leave **Network > Network Security >
   Command Protect** **Disabled**. If protection is enabled later, add the same
   administrator password to Pixel Server using the optional file below.
6. Set **Eco Management > Standby Mode** to **Normal** so `PON` remains
   reachable while the projector is in standby.
7. PJLink may remain disabled.

The adapter implements the documented `NTCONTROL` greeting, MD5 challenge,
`00<command>\r` frame and one-connection-per-command lifecycle. The allowlist
contains only:

- power: `PON`, `POF`, `QPW`;
- shutter: `OSH:0`, `OSH:1`, `QSH`;
- input: `IIS:HD1`, `IIS:HD2`, `IIS:DL1`, `QIN`;
- light-source state/runtime: `Q$S`, `Q$L`.

## Optional Server credential

No Pixel Server password file is required while **Command Protect** is
disabled. The administrator login for the manufacturer's Web Control page is
separate and continues to work normally.

If **Command Protect** is enabled, put the matching projector administrator
password on Pixel Server as follows.

For a Windows installation, put only the password (no newline) in:

```text
C:\ProgramData\Pixel Brightness\secrets\panasonic-projector-password.txt
```

Create it once from an elevated PowerShell window without putting the password
in the command history:

```powershell
$secureProjectorPassword = Read-Host 'Panasonic administrator password' -AsSecureString
$projectorPassword = [Net.NetworkCredential]::new('', $secureProjectorPassword).Password
$passwordPath = Join-Path $env:ProgramData 'Pixel Brightness\secrets\panasonic-projector-password.txt'
[IO.File]::WriteAllText($passwordPath, $projectorPassword, [Text.UTF8Encoding]::new($false))
$projectorPassword = $null
```

The stable Server launcher reads that SYSTEM-owned file and uses the
administrator username `dispadmin`. Restart the **Pixel Brightness Server**
scheduled task after creating or replacing the file. The Control page reports
`PASSWORD LOADED` but never returns the password.

For a development launch, use either:

```text
PB_PROJECTOR_CONTROL_USERNAME
PB_PROJECTOR_CONTROL_PASSWORD
```

or the preferred file variable:

```text
PB_PROJECTOR_CONTROL_PASSWORD_FILE
```

## Web Control operation

Open **Projector Control**, enter the five fixed IP addresses, confirm each
explicit Output A-E binding, and save. Available operations are:

- power on or standby, individually or as a staggered group;
- shutter open or close, individually or as a group;
- select HDMI 1, HDMI 2, or DIGITAL LINK;
- query power, light source, shutter, input, and laser hours;
- open the manufacturer's browser Web Control for one device.

After power-on, Pixel Brightness waits 60 seconds before its automatic full
status verification. During light-source startup, a manual refresh queries the
power/light transition without falsely treating a busy reply as a LAN outage.
Closing the shutter blanks picture and audio; it does not turn off the light
source. Use **Standby** when the projector itself should stop.

Group results are per device and every request carries an explicit projector
list. A partial failure never appears as an all-device success. A lost response
after a mutating command is labeled `REFRESH BEFORE RETRY` because its physical
outcome is unknown.

## Sources

- [Panasonic PT-VMZ71/61/51 product resources](https://docs.connect.panasonic.com/projector/products/vmz71/resources/)
- [Panasonic operating instructions](https://bizpartner.panasonic.net/public/system/files/files/fields/field_file/psd/2023/04/10/vmz71_manual_en_1681091095.0791.pdf)
- [Panasonic control command list](https://bizpartner.panasonic.net/public/system/files/files/fields/field_file/psd/2022/02/25/vmz71series_controlcommands_1645755921.7658.pdf)
