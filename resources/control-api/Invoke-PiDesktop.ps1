# Portable local API client. No global configuration or external runtime required.
[CmdletBinding()]
param(
    [ValidateSet('projects','chats','select','start','status','reply','abort')]
    [string]$Action = 'projects',
    [string]$TaskId,
    [string]$ConversationId,
    [string]$ProjectId,
    [string]$Message,
    [string[]]$Paths,
    [string]$QuestionId,
    [AllowEmptyString()][string]$Value,
    [Nullable[bool]]$Confirmed,
    [switch]$Cancel,
    [AllowEmptyString()][string]$CustomInput,
    [switch]$Diff
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$connectionPath = Join-Path $PSScriptRoot 'data/control-api/connection.json'
if (-not (Test-Path -LiteralPath $connectionPath -PathType Leaf)) {
    throw 'Connection file not found. Start Pi Desktop from this folder first.'
}
$connection = Get-Content -LiteralPath $connectionPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($connection.url -cnotmatch '^http://127\.0\.0\.1:[0-9]+$' -or $connection.token -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Invalid local connection file.'
}
$method = 'GET'
$route = '/' + $Action
$body = @{}
if ($Action -in @('status','reply','abort')) {
    if ($TaskId -cnotmatch '^[a-f0-9-]{36}$') { throw 'A valid task id is required.' }
    $route = '/tasks/' + $TaskId
    if ($Action -ne 'status') { $route += '/' + $Action; $method = 'POST' }
    if ($Action -eq 'status' -and $Diff) { $route += '?diff=true' }
}
switch ($Action) {
    'select' {
        if (-not $ConversationId) { throw 'ConversationId is required.' }
        $method = 'POST'
        $body.conversationId = $ConversationId
    }
    'start' {
        if ([string]::IsNullOrWhiteSpace($Message)) { throw 'Message is required.' }
        if ($ConversationId -and $ProjectId) { throw 'Use ConversationId or ProjectId, not both.' }
        $method = 'POST'
        $route = '/tasks'
        $body.message = $Message
        if ($ConversationId) { $body.conversationId = $ConversationId }
        if ($ProjectId) { $body.projectId = $ProjectId }
        if ($Paths) { $body.paths = @($Paths) }
    }
    'reply' {
        if (-not $QuestionId) { throw 'QuestionId is required.' }
        $body.id = $QuestionId
        if ($PSBoundParameters.ContainsKey('Value')) { $body.value = $Value }
        if ($PSBoundParameters.ContainsKey('Confirmed')) { $body.confirmed = [bool]$Confirmed }
        if ($Cancel) { $body.cancelled = $true }
        if ($PSBoundParameters.ContainsKey('CustomInput')) { $body.customInput = $CustomInput }
    }
}
$request = @{
    Uri = $connection.url + $route
    Method = $method
    Headers = @{ Authorization = 'Bearer ' + $connection.token }
    TimeoutSec = 30
    MaximumRedirection = 0
}
if ($method -eq 'POST') {
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Body = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 20 -Compress))
}
# Do not echo request headers or the connection file: they contain the bearer key.
$response = Invoke-WebRequest @request -UseBasicParsing
# Windows PowerShell 5.1 otherwise guesses a non-UTF-8 encoding for JSON.
$result = [System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
if ($Action -in @('projects','chats')) {
    $items = @()
    if ($null -ne $result) { $items = @($result) }
    ConvertTo-Json -InputObject $items -Depth 30 -Compress
} else {
    ConvertTo-Json -InputObject $result -Depth 30 -Compress
}
