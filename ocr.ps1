param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
function Await($op,[Type]$type) {
 $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
 $task=$method.MakeGenericMethod($type).Invoke($null,@($op));$task.Wait();return $task.Result
}
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
 $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
 if($decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension){throw 'Image exceeds Windows OCR dimension limit. Split screenshot into smaller images.'}
 $bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
 try {
  $language=New-Object Windows.Globalization.Language('zh-Hans-CN')
  $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if($null -eq $engine){throw 'Chinese OCR language pack unavailable.'}
  $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines=@();$index=0
  foreach($line in $result.Lines){
   $words=@($line.Words);$x=($words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum;$y=($words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum
   $right=($words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width} | Measure-Object -Maximum).Maximum;$bottom=($words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
   $lines+=@{id=$index;text=$line.Text;box=@{x=$x;y=$y;width=$right-$x;height=$bottom-$y}};$index++
  }
  @{width=$decoder.PixelWidth;height=$decoder.PixelHeight;engine='Windows.Media.Ocr zh-Hans-CN';lines=$lines} | ConvertTo-Json -Depth 8 -Compress
 } finally {if($bitmap){$bitmap.Dispose()}}
} finally {$stream.Dispose()}
