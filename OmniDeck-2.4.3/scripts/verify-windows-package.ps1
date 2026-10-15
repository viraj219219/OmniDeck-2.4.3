# Verifies the BUILT Windows NSIS installer (run on a Windows runner).
#   ./scripts/verify-windows-package.ps1 -BundleDir src-tauri/target/release/bundle
# The installer is installed silently into a temporary directory, then the ACTUAL bundled
# soffice.exe is run for a version check and a real three-slide PPTX -> PDF conversion.
param([Parameter(Mandatory)][string]$BundleDir, [int]$ConvertTimeoutSeconds = 300)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root "scripts/libreoffice-version.txt") -Raw).Trim()
$fixture = Join-Path $root "src-tauri/test-fixtures/three-slides.pptx"
$fails = New-Object System.Collections.Generic.List[string]
function Fail($m) { $script:fails.Add($m); Write-Host "FAIL: $m" -ForegroundColor Red }
function Ok($m) { Write-Host "ok:   $m" }

$nsis = Get-ChildItem -Path (Join-Path $BundleDir "nsis") -Filter *-setup.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nsis) {
    Fail "no NSIS *-setup.exe under $BundleDir/nsis"
} else {
    if ($nsis.Length -lt 100MB) {
        Fail "NSIS installer is only $([int]($nsis.Length/1MB)) MB: the bundled LibreOffice is clearly not inside"
    } else {
        Ok "NSIS installer is $([int]($nsis.Length/1MB)) MB"
    }

    $target = Join-Path ([IO.Path]::GetTempPath()) ("omnideck-nsis-" + [Guid]::NewGuid().ToString("N"))
    try {
        # NSIS requires /D=... to be the final argument. Temp path has no spaces on
        # GitHub-hosted Windows runners, keeping this command line unambiguous.
        $install = Start-Process -FilePath $nsis.FullName -ArgumentList @("/S", "/D=$target") -PassThru -Wait -NoNewWindow
        if ($install.ExitCode -ne 0) {
            Fail "silent NSIS installation failed with exit code $($install.ExitCode)"
        } else {
            Ok "NSIS installer completed a silent installation"
            $soffice = Get-ChildItem -Path $target -Recurse -Filter soffice.exe -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match "resources\\libreoffice\\program\\soffice\.exe$" } |
                Select-Object -First 1

            if (-not $soffice) {
                Fail "installed NSIS package does not contain resources\libreoffice\program\soffice.exe"
            } else {
                Ok "installed package contains $($soffice.FullName.Substring($target.Length))"
                $verOut = (Get-Item $soffice.FullName).VersionInfo.ProductVersion
                if ($verOut -like "$version*") {
                    Ok "soffice.exe ProductVersion $verOut matches $version"
                } else {
                    Fail "soffice.exe ProductVersion '$verOut' != $version"
                }

                $work = Join-Path ([IO.Path]::GetTempPath()) ("omnideck-vconv-" + [Guid]::NewGuid().ToString("N"))
                New-Item -ItemType Directory -Force -Path $work | Out-Null
                $profile = Join-Path $work "profile"
                $uri = ([Uri]$profile).AbsoluteUri
                $args = @("--headless", "--norestore", "-env:UserInstallation=$uri", "--convert-to", "pdf", "--outdir", $work, $fixture)
                $outF = Join-Path $work "o.txt"
                $errF = Join-Path $work "e.txt"
                $inF = Join-Path $work "i.txt"
                Set-Content $inF "" -NoNewline
                $proc = Start-Process -FilePath $soffice.FullName -ArgumentList ($args | ForEach-Object { '"' + $_ + '"' }) -PassThru -NoNewWindow -RedirectStandardOutput $outF -RedirectStandardError $errF -RedirectStandardInput $inF
                if (-not $proc.WaitForExit($ConvertTimeoutSeconds * 1000)) {
                    & "$env:WINDIR\System32\taskkill.exe" /T /F /PID $proc.Id *> $null
                    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                    Fail "packaged soffice.exe did not finish converting within $ConvertTimeoutSeconds s (killed)"
                } else {
                    $pdf = Join-Path $work "three-slides.pdf"
                    if ($proc.ExitCode -ne 0 -or -not (Test-Path $pdf)) {
                        Fail "packaged soffice.exe conversion failed (exit $($proc.ExitCode)): $((Get-Content $errF -Raw))"
                    } else {
                        $pages = ([regex]::Matches([IO.File]::ReadAllText($pdf, [Text.Encoding]::GetEncoding(28591)), '/Type\s*/Page[^s]')).Count
                        if ($pages -eq 3) { Ok "installed runtime converted a real .pptx to a 3-page PDF" } else { Fail "installed runtime produced $pages pages, expected 3" }
                    }
                }
                Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        Fail "could not install or validate the NSIS package: $($_.Exception.Message)"
    } finally {
        # The CI runner is disposable; still use the product's own uninstaller when
        # it exists, then remove leftovers. Ignore cleanup errors so they do not mask tests.
        $uninstaller = Get-ChildItem -Path $target -Recurse -Filter unins*.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($uninstaller) {
            try { Start-Process -FilePath $uninstaller.FullName -ArgumentList @("/S") -Wait -NoNewWindow | Out-Null } catch {}
        }
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if ($fails.Count -gt 0) {
    Write-Host "WINDOWS PACKAGE VERIFICATION FAILED ($($fails.Count))" -ForegroundColor Red
    exit 1
}
Write-Host "Windows package verification passed."
