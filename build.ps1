# Regenerates the generated CSS: the window glass in libraryroot.custom.css (from
# its "the window as one glass card" marker to the end), glass-clear.css,
# friends.custom.css (friends.src.css + the window glass) and liquid.css
# (liquid.src.css + the plain window edge).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$marker = "/* ------------------------------------------------------------- the window as one glass card */"
$lib = Get-Content libraryroot.custom.css -Raw -Encoding UTF8
$cut = $lib.IndexOf($marker)
if ($cut -lt 0) { throw "marker not found in libraryroot.custom.css" }
$utf8 = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText("$PWD\libraryroot.custom.css", $lib.Substring(0, $cut) + ((python -I gen_rim.py frosted) -join "`n") + "`n", $utf8)
[IO.File]::WriteAllText("$PWD\glass-clear.css", ((python -I gen_rim.py clear) -join "`n") + "`n", $utf8)
$friends = (Get-Content friends.src.css -Raw -Encoding UTF8) + ((python -I gen_rim.py friends) -join "`n") + "`n"
[IO.File]::WriteAllText("$PWD\friends.custom.css", $friends, $utf8)
$liquid = (Get-Content liquid.src.css -Raw -Encoding UTF8) + ((python -I gen_rim.py liquid) -join "`n") + "`n"
[IO.File]::WriteAllText("$PWD\liquid.css", $liquid, $utf8)
"Built libraryroot.custom.css, glass-clear.css, friends.custom.css, liquid.css"
