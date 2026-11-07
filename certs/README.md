# Extra root certificates

Put your company's root certificate here (`.crt`, `.cer` or `.pem`, Base-64 or binary) if your network inspects HTTPS traffic. You can tell it does when installing an agent in a VaultOS terminal fails with `self-signed certificate in certificate chain`.

`compose.yaml` mounts this folder at `/certs`. Each time the container starts it trusts every certificate in here, for curl, git, npm, pip and the agents. Run `docker compose up -d` after adding one; you don't need to rebuild.

Certificates here are never committed (see `.gitignore`).

**Get the certificate on Windows.** In PowerShell, from the `vaultos` folder, this connects to a site through your network and saves every certificate above the site's own (your company's root and intermediates) into this folder:

```powershell
$tcp = New-Object Net.Sockets.TcpClient('cursor.com', 443)
$ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, { $true })
$ssl.AuthenticateAsClient('cursor.com')
$chain = New-Object Security.Cryptography.X509Certificates.X509Chain
$null = $chain.Build($ssl.RemoteCertificate)
$i = 0
$chain.ChainElements | Select-Object -Skip 1 | ForEach-Object {
  $i++
  "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($_.Certificate.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----" |
    Out-File -Encoding ascii "certs\network-$i.crt"
  $_.Certificate.Subject
}
$ssl.Dispose(); $tcp.Dispose()
```

It prints the name of each certificate it saved. On a network that doesn't inspect traffic these are public roots you already trust, and saving them does no harm.
