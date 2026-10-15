[CmdletBinding()]
param(
    [string]$Destination = "src-tauri/resources/libreoffice",
    [string]$Version = "26.8.0",
    [int]$MaxRetries = 4,
    [string]$SmokeFixture = "src-tauri/test-fixtures/three-slides.pptx",
    [int]$SmokePages = 3,
    # Test hook only: define the functions and return, so tests can exercise the
    # download / process / smoke helpers without running the whole vendoring flow.
    [switch]$LoadFunctionsOnly
)

# Fail-closed: every check below ends in a TERMINATING error, and the script
# turns any such error into exit code 1 (see the end of the file). The exit
# code never depends on $LASTEXITCODE: native tools are run through
# Invoke-NativeCapture, which reads Process.ExitCode directly.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 does not always auto-load this framework assembly
# before resolving HttpClient types. Load it explicitly before any typed use.
try {
    Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
} catch {
    throw "Could not load .NET System.Net.Http required for the streamed LibreOffice download. Run this script in Windows PowerShell 5.1 or PowerShell 7 with .NET support. Details: $($_.Exception.Message)"
}

# LibreOffice's official Windows x64 MSI. The hash is pinned WITH the version so
# a mirror/proxy cannot silently replace the installer with different bytes.
$KnownSha256 = @{
    "26.8.0" = "4AA6C6E1895F4055104EFFCB556BD3362D20C6AD707C149543304F395EF9DB95"
}

# Expected release is about 358 MB. Reject obviously empty/truncated files before
# hashing/extraction. The hash check is the authoritative integrity check.
$MinimumMsiBytes = 100MB

function New-DownloadHttpClient {
    param([int]$TimeoutMinutes = 30)
    $handler = New-Object System.Net.Http.HttpClientHandler
    # The TDF download endpoint redirects to a mirror. Follow redirects.
    $handler.AllowAutoRedirect = $true
    $handler.MaxAutomaticRedirections = 10
    # Range/resume requires the raw bytes: never let the handler transparently decompress.
    $handler.AutomaticDecompression = [System.Net.DecompressionMethods]::None
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes($TimeoutMinutes)
    [void]$client.DefaultRequestHeaders.UserAgent.TryParseAdd("OmniDeck/$Version LibreOffice-vendor")
    return $client
}

# Resumable, retried download. The partial file is KEPT between attempts (and
# between runs) and continued with an HTTP Range request; it is deleted only when
# it is provably unusable (server sent a mismatching range, or it is longer than
# the advertised size). Client errors (4xx except 408/429) are not retried.
function Invoke-ResumableDownload {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$OutputPath,
        [int]$Retries = 4,
        [long]$MinimumBytes = 0,
        [int]$DelayCapSeconds = 30,
        [int]$TimeoutMinutes = 30
    )
    if (([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) -eq 0) {
        # Never enable obsolete TLS 1.0/1.1; only add 1.2 where it is off.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    $client = New-DownloadHttpClient -TimeoutMinutes $TimeoutMinutes
    try {
        $lastError = "unknown error"
        for ($attempt = 1; $attempt -le $Retries; $attempt++) {
            $permanent = $false
            $request = $null
            $response = $null
            try {
                [long]$existing = 0
                if (Test-Path -LiteralPath $OutputPath -PathType Leaf) { $existing = (Get-Item -LiteralPath $OutputPath).Length }
                Write-Host "LibreOffice download attempt $attempt/$Retries (resuming from $existing bytes)..."
                Write-Host "URL: $Uri"

                $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Uri)
                [void]$request.Headers.Accept.TryParseAdd("application/octet-stream")
                if ($existing -gt 0) {
                    $request.Headers.Range = New-Object System.Net.Http.Headers.RangeHeaderValue([long]$existing, $null)
                }
                $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
                $status = [int]$response.StatusCode
                $contentRange = $response.Content.Headers.ContentRange

                if ($status -eq 416) {
                    # Range not satisfiable: either the partial is already complete or it is stale.
                    if ($existing -gt 0 -and $null -ne $contentRange -and $null -ne $contentRange.Length -and [long]$contentRange.Length -eq $existing) {
                        Write-Host "Partial file already holds the complete $existing bytes."
                        return $existing
                    }
                    Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
                    throw "HTTP 416 for the resume request; discarded the stale partial file and will restart from the beginning."
                }
                if (-not $response.IsSuccessStatusCode) {
                    if ($status -ge 400 -and $status -lt 500 -and $status -ne 408 -and $status -ne 429) { $permanent = $true }
                    throw "HTTP $status $($response.ReasonPhrase)"
                }

                [long]$start = 0
                $mode = [System.IO.FileMode]::Create
                if ($status -eq 206) {
                    $from = $null
                    if ($null -ne $contentRange) { $from = $contentRange.From }
                    if ($existing -le 0 -or $null -eq $from -or [long]$from -ne $existing) {
                        Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
                        throw "Server answered with an unexpected byte range (from=$from, wanted $existing); discarded the partial file."
                    }
                    $mode = [System.IO.FileMode]::Append
                    $start = $existing
                } elseif ($existing -gt 0) {
                    Write-Host "Server ignored the Range request (HTTP $status); restarting the download from the beginning."
                }

                $contentLength = $response.Content.Headers.ContentLength
                $expectedTotal = $null
                if ($null -ne $contentLength) { $expectedTotal = [long]($start + [long]$contentLength) }

                $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                try {
                    $file = New-Object System.IO.FileStream($OutputPath, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                    try {
                        $buffer = New-Object byte[] (1024 * 1024)
                        [long]$total = $start
                        $lastReport = [DateTime]::UtcNow
                        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                            $file.Write($buffer, 0, $read)
                            $total += $read
                            if (([DateTime]::UtcNow - $lastReport).TotalSeconds -ge 2) {
                                if ($null -ne $expectedTotal) {
                                    Write-Host ("  {0:N1} MB / {1:N1} MB ({2}%)" -f ($total / 1MB), ($expectedTotal / 1MB), [Math]::Round(($total / [double]$expectedTotal) * 100, 1))
                                } else {
                                    Write-Host ("  {0:N1} MB downloaded" -f ($total / 1MB))
                                }
                                $lastReport = [DateTime]::UtcNow
                            }
                        }
                    } finally { $file.Dispose() }
                } finally { $stream.Dispose() }

                [long]$length = (Get-Item -LiteralPath $OutputPath).Length
                if ($null -ne $expectedTotal -and $length -gt $expectedTotal) {
                    Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
                    throw "Downloaded $length bytes but only $expectedTotal were advertised; discarded the file."
                }
                if ($null -ne $expectedTotal -and $length -lt $expectedTotal) {
                    # Keep the partial: the next attempt resumes from here.
                    throw "Incomplete download: received $length of $expectedTotal bytes."
                }
                if ($length -lt $MinimumBytes) {
                    Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
                    $permanent = $true
                    throw "Downloaded file is only $length bytes; expected at least $MinimumBytes (not a LibreOffice installer)."
                }
                return $length
            }
            catch {
                $lastError = $_.Exception.Message
                Write-Warning "Download attempt $attempt failed: $lastError"
                if ($permanent) { break }
                if ($attempt -lt $Retries) {
                    $delay = [Math]::Min($DelayCapSeconds, [Math]::Pow(2, $attempt))
                    Write-Host "Retrying in $delay seconds..."
                    Start-Sleep -Seconds $delay
                }
            }
            finally {
                if ($null -ne $response) { $response.Dispose() }
                if ($null -ne $request) { $request.Dispose() }
            }
        }
        throw "LibreOffice download failed. Last error: $lastError"
    }
    finally {
        $client.Dispose()
    }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function ConvertTo-ArgumentString([string]$Value) {
    return '"' + ($Value -replace '"', '\"') + '"'
}

# Runs a native program and returns its REAL exit code (Process.ExitCode), its
# combined output and whether it hit the timeout. Never touches $LASTEXITCODE.
#
# ROOT CAUSE of the earlier smoke-conversion hang: soffice launchers (soffice,
# soffice.com) start a SEPARATE soffice.bin worker that inherits the launcher's
# redirected stdout/stderr PIPES. With pipe capture, the unbounded
# $p.WaitForExit() that follows a timeout (and the ReadToEnd tasks) block until
# EVERY holder of the pipe closes it - i.e. until the orphaned soffice.bin exits,
# which it never does after a timeout kill that only hit the launcher. Fix:
#   * capture output through FILES (a file can never block the way a pipe does),
#   * redirect stdin so the worker can't wait on a console,
#   * every wait is bounded,
#   * on timeout, kill the whole tree (taskkill /T on Windows) AND every process
#     whose command line mentions $KillPattern (the private profile directory).
function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 120,
        [string]$KillPattern = ""
    )
    $capDir = Join-Path ([IO.Path]::GetTempPath()) ("omnideck-cap-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $capDir | Out-Null
    $outFile = Join-Path $capDir "out.txt"
    $errFile = Join-Path $capDir "err.txt"
    $inFile = Join-Path $capDir "in.txt"
    $exitFile = Join-Path $capDir "native-exit-code.txt"
    Set-Content -LiteralPath $inFile -Value "" -NoNewline
    try {
        # Use a child Windows PowerShell with EncodedCommand instead of cmd.exe
        # and a .cmd wrapper. This avoids cmd /c quote parsing for paths with spaces.
        # The encoded command is one Base64 token, so Start-Process cannot split it.
        $quoteLiteral = { param([string]$v) "'" + ($v -replace "'", "''") + "'" }
        $nativePathLiteral = & $quoteLiteral $FilePath
        $exitPathLiteral = & $quoteLiteral $exitFile
        $argumentLiterals = @($Arguments | ForEach-Object { & $quoteLiteral $_ })
        $nativeArgsLiteral = if ($argumentLiterals.Count -gt 0) { $argumentLiterals -join "," } else { "" }
        $childScript = @"
`$ErrorActionPreference = 'Stop'
try {
    `$nativeArgs = @($nativeArgsLiteral)
    & $nativePathLiteral @nativeArgs
    `$nativeCode = `$LASTEXITCODE
    if (`$null -eq `$nativeCode) { throw 'Native process did not set LASTEXITCODE.' }
    [IO.File]::WriteAllText($exitPathLiteral, [string]`$nativeCode, [Text.Encoding]::ASCII)
    exit ([int]`$nativeCode)
} catch {
    [Console]::Error.WriteLine(`$_.Exception.Message)
    [IO.File]::WriteAllText($exitPathLiteral, '1', [Text.Encoding]::ASCII)
    exit 1
}
"@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
        # Windows PowerShell 5.1 explicitly: $PSHOME is the pwsh folder under PowerShell 7, which has no powershell.exe.
        $childPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $sp = @{
            FilePath = $childPowerShell
            ArgumentList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
            PassThru = $true
            NoNewWindow = $true
            RedirectStandardOutput = $outFile
            RedirectStandardError = $errFile
            RedirectStandardInput = $inFile
        }
        try { $p = Start-Process @sp }
        catch { throw "Could not launch native process helper for '$FilePath': $($_.Exception.Message)" }
        $timedOut = $false
        if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            & "$env:WINDIR\System32\taskkill.exe" /T /F /PID $p.Id *> $null
            if ($KillPattern) {
                Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($KillPattern) } |
                    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            }
            try { $p.Kill() } catch { }
            [void]$p.WaitForExit(15000)
        }
        if ($timedOut) {
            $code = -1
        } else {
            if (-not (Test-Path -LiteralPath $exitFile -PathType Leaf)) {
                throw "Native process wrapper did not write an exit code for: $FilePath"
            }
            $rawCode = [IO.File]::ReadAllText($exitFile).Trim()
            $parsedCode = 0
            if (-not [int]::TryParse($rawCode, [ref]$parsedCode)) {
                throw "Native process wrapper wrote an invalid exit code '$rawCode' for: $FilePath"
            }
            $code = $parsedCode
        }
        $text = ""
        foreach ($f in @($outFile, $errFile)) {
            if (Test-Path -LiteralPath $f) { $text += [IO.File]::ReadAllText($f) }
        }
        return [pscustomobject]@{ ExitCode = $code; Output = $text.Trim(); TimedOut = $timedOut }
    }
    finally {
        Remove-Item -LiteralPath $capDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Assert-LibreOfficeVersion {
    param([Parameter(Mandatory)][string]$Soffice, [Parameter(Mandatory)][string]$Expected)
    $r = Invoke-NativeCapture -FilePath $Soffice -Arguments @("--version") -TimeoutSeconds 120
    if ($r.TimedOut) { throw "Bundled LibreOffice timed out during --version validation." }
    if ($r.ExitCode -ne 0) { throw "Bundled LibreOffice failed its --version validation (exit code $($r.ExitCode)). Output: $($r.Output)" }
    $wanted = "LibreOffice " + (($Expected -split '\.')[0..1] -join '.')
    if (-not $r.Output.StartsWith($wanted)) { throw "Bundled LibreOffice reports '$($r.Output)' but $Expected was expected." }
    Write-Host "Validated runtime: $($r.Output)"
}

# soffice.exe is a GUI-subsystem launcher: it prints nothing for --version. The
# console wrapper soffice.com is what the vendor checks run, so it must be shipped
# together with soffice.exe, soffice.bin and the program/share trees.
function Assert-RuntimeFiles {
    param([Parameter(Mandatory)][string]$Root)
    foreach ($rel in @("program\soffice.exe", "program\soffice.com", "program\soffice.bin")) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $rel) -PathType Leaf)) {
            throw "LibreOffice runtime is incomplete: $rel is missing."
        }
    }
    $dlls = @(Get-ChildItem -LiteralPath (Join-Path $Root "program") -Filter *.dll -File -ErrorAction SilentlyContinue).Count
    if ($dlls -lt 20) { throw "LibreOffice runtime is incomplete: only $dlls DLLs under program\." }
    $share = Join-Path $Root "share"
    if (-not (Test-Path -LiteralPath $share -PathType Container) -or @(Get-ChildItem -LiteralPath $share -ErrorAction SilentlyContinue).Count -eq 0) {
        throw "LibreOffice runtime is incomplete: the share\ directory is missing or empty."
    }
}

# Real PPTX -> PDF conversion with the staged runtime, so Impress, the PDF export
# filter and every DLL are proven to load - not just that --version prints.
function Invoke-SmokeConversion {
    param(
        [Parameter(Mandatory)][string]$Soffice,
        [Parameter(Mandatory)][string]$Fixture,
        [int]$ExpectedPages = 3,
        [int]$TimeoutSeconds = 300
    )
    if (-not (Test-Path -LiteralPath $Fixture -PathType Leaf)) { throw "Smoke-test fixture missing: $Fixture" }
    $work = Join-Path ([IO.Path]::GetTempPath()) ("omnideck-smoke-" + [Guid]::NewGuid().ToString("N"))
    $out = Join-Path $work "out"
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    try {
        $profileUrl = ([Uri](Join-Path $work "profile")).AbsoluteUri
        $r = Invoke-NativeCapture -FilePath $Soffice -TimeoutSeconds $TimeoutSeconds -KillPattern (Join-Path $work "profile") -Arguments @(
            "--headless", "--norestore", "-env:UserInstallation=$profileUrl",
            "--convert-to", "pdf", "--outdir", $out, $Fixture)
        if ($r.TimedOut) { throw "Smoke conversion timed out after $TimeoutSeconds s." }
        $pdf = Join-Path $out ([IO.Path]::GetFileNameWithoutExtension($Fixture) + ".pdf")
        if ($r.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $pdf -PathType Leaf) -or (Get-Item -LiteralPath $pdf).Length -eq 0) {
            throw "Smoke conversion failed (exit code $($r.ExitCode)). Output: $($r.Output)"
        }
        $text = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($pdf))
        if (-not $text.StartsWith("%PDF-")) { throw "Smoke conversion produced a file that is not a PDF." }
        $pages = [regex]::Matches($text, '/Type\s*/Page[^s]').Count
        if ($pages -ne $ExpectedPages) { throw "Smoke conversion produced $pages PDF pages, expected $ExpectedPages (one per slide)." }
        Write-Host "Smoke conversion OK: $([IO.Path]::GetFileName($Fixture)) -> PDF with $pages pages (one per slide)."
    }
    finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($LoadFunctionsOnly) { return }

# ------------------------------------------------------------------ main flow
if (-not $KnownSha256.ContainsKey($Version)) {
    Write-Host "ERROR: Unsupported LibreOffice version '$Version'. Add its verified SHA-256 to KnownSha256 before using it." -ForegroundColor Red
    $global:LASTEXITCODE = 1
    exit 1
}

$script:ExitCode = 0
$expectedHash = $KnownSha256[$Version]
$url = "https://download.documentfoundation.org/libreoffice/stable/$Version/win/x86_64/LibreOffice_${Version}_Win_x86-64.msi"

$root = (Resolve-Path ".").Path
$dest = [IO.Path]::GetFullPath((Join-Path $root $Destination))
$destParent = Split-Path -Parent $dest
$fixture = [IO.Path]::GetFullPath((Join-Path $root $SmokeFixture))
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } elseif ($env:TEMP) { $env:TEMP } else { [IO.Path]::GetTempPath() }
$partial = Join-Path $tempRoot "omnideck-libreoffice-$Version.msi.partial"   # survives failures => resumable
$msi = Join-Path $tempRoot "omnideck-libreoffice-$Version.msi"
$extract = Join-Path $tempRoot "omnideck-libreoffice-$Version-extract"
$destStage = Join-Path $destParent ("libreoffice-staging-" + [Guid]::NewGuid().ToString("N"))
$backup = $null
$swapped = $false

try {
    Write-Host "Preparing LibreOffice $Version for OmniDeck..."
    Write-Host "Official source: $url"
    New-Item -ItemType Directory -Force -Path $destParent | Out-Null

    # Leftovers of a killed earlier run (never the live bundle, never the resumable partial).
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $destParent -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "libreoffice-staging-*" -or $_.Name -like "libreoffice-backup-*" } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

    # Download + verify. A hash mismatch discards the (possibly spliced) partial and
    # retries once from scratch; a second mismatch is fatal.
    for ($pass = 1; $pass -le 2; $pass++) {
        [void](Invoke-ResumableDownload -Uri $url -OutputPath $partial -Retries $MaxRetries -MinimumBytes $MinimumMsiBytes)
        Move-Item -LiteralPath $partial -Destination $msi -Force
        $actualHash = Get-Sha256 $msi
        Write-Host "Downloaded SHA-256: $actualHash"
        Write-Host "Expected  SHA-256: $expectedHash"
        if ($actualHash -eq $expectedHash) { break }
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
        if ($pass -eq 2) { throw "LibreOffice MSI SHA-256 mismatch twice. The download is not the expected official $Version installer." }
        Write-Warning "SHA-256 mismatch; discarding the download and retrying once from scratch."
    }

    # Authenticode is an additional check; SHA-256 is the release-content pin.
    $sig = Get-AuthenticodeSignature -LiteralPath $msi
    if ($sig.Status -ne "Valid") {
        throw "LibreOffice MSI Authenticode signature validation failed: $($sig.Status) $($sig.StatusMessage)"
    }
    Write-Host "MSI integrity and Authenticode signature verified."

    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    $proc = Start-Process -FilePath "$env:WINDIR\System32\msiexec.exe" `
        -ArgumentList @('/a', "`"$msi`"", '/qn', "TARGETDIR=`"$extract`"") -Wait -PassThru -NoNewWindow
    if (@(0, 3010) -notcontains $proc.ExitCode) {
        throw "msiexec administrative extraction failed with exit code $($proc.ExitCode)"
    }

    $program = Get-ChildItem -Path $extract -Filter soffice.exe -Recurse -File | Select-Object -First 1
    if (-not $program) { throw "Extracted LibreOffice runtime does not contain soffice.exe." }
    $loRoot = $program.Directory.Parent.FullName

    # One copy only, straight into a staging directory beside the destination
    # (same volume, so the final swap is a rename). The live bundle is untouched
    # until every validation below has passed.
    New-Item -ItemType Directory -Force -Path $destStage | Out-Null
    Copy-Item -Path (Join-Path $loRoot '*') -Destination $destStage -Recurse -Force
    Assert-RuntimeFiles -Root $destStage
    Assert-LibreOfficeVersion -Soffice (Join-Path $destStage "program\soffice.com") -Expected $Version
    Invoke-SmokeConversion -Soffice (Join-Path $destStage "program\soffice.com") -Fixture $fixture -ExpectedPages $SmokePages

    @("libreoffice_version=$Version", "platform=windows-x86_64", "source_url=$url", "archive_sha256=$($expectedHash.ToLowerInvariant())",
      "launcher=program\soffice.exe") | Set-Content -LiteralPath (Join-Path $destStage "OMNIDECK-LIBREOFFICE.txt") -Encoding ASCII

    # Swap, then re-verify the installed copy; roll back on any failure.
    if (Test-Path -LiteralPath $dest) {
        $backup = Join-Path $destParent ("libreoffice-backup-" + [Guid]::NewGuid().ToString("N"))
        Move-Item -LiteralPath $dest -Destination $backup
    }
    Move-Item -LiteralPath $destStage -Destination $dest
    $swapped = $true
    Assert-RuntimeFiles -Root $dest
    Assert-LibreOfficeVersion -Soffice (Join-Path $dest "program\soffice.com") -Expected $Version
    if ($backup) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue; $backup = $null }

    Write-Host "LibreOffice $Version successfully vendored at $dest"
    Write-Host "OmniDeck bundles it; end users do NOT need LibreOffice installed separately."
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $script:ExitCode = 1
    # Roll back if the swap had started: a failed post-swap check must never leave
    # a bad bundle in place, with or without a previous one to restore.
    if ($swapped -and -not $backup -and (Test-Path -LiteralPath $dest)) {
        Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($backup -and (Test-Path -LiteralPath $backup)) {
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue }
        try { Move-Item -LiteralPath $backup -Destination $dest -Force; Write-Host "Previous bundle restored." }
        catch { Write-Host "WARNING: could not restore the previous bundle from $backup : $($_.Exception.Message)" -ForegroundColor Yellow }
    }
}
finally {
    # The resumable partial is intentionally kept after a FAILED run (so the next run
    # continues it) and was already moved to $msi after a complete one.
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    Remove-Item $destStage -Recurse -Force -ErrorAction SilentlyContinue
}

# Explicit exit code: never rely on a stale $LASTEXITCODE left by a native command.
$global:LASTEXITCODE = $script:ExitCode
exit $script:ExitCode
