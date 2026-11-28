<#
原生验收由本次新建的普通账户及实际加载的档案完成，构建只执行一次，相同源码与产物以只读权限交给测试。
临时账户只写自己的夹具与证据，退出后按精确身份回收档案、账户和目录；产品私有文件检查始终使用原有规则。
#>
[CmdletBinding()]
param(
    [ValidateSet('Parent', 'Child', 'Cleanup')][string]$Mode = 'Parent',
    [Parameter(Mandatory)][string]$Workspace,
    [Parameter(Mandatory)][string]$EvidenceDirectory,
    [string]$NodePath,
    [Parameter(Mandatory)][string]$Source,
    [string]$ExpectedSid,
    [string]$OutputRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

<#
证据文件仅保存在调用者明确提供的本次目录内，序列化深度覆盖身份与构建摘要，不能把未知对象无限展开到日志。
#>
function Write-Record([string]$Name, $Value) {
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory $Name) -Encoding utf8
}

<#
构建摘要同时绑定确切运行时和全部原生构建成员，普通账户直接读取这些锁定文件，测试前后不得出现替换或重建。
#>
function Get-BuildHashes {
    $hashes = @{}
    $hashes['node'] = (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Workspace 'apps/runtime/build') -File -Recurse) {
        $hashes[$file.FullName.Substring($Workspace.Length)] = (Get-FileHash -LiteralPath $file.FullName).Hash
    }
    return $hashes
}

if ($Mode -eq 'Child') {
    # 启动闸门由父身份独占写入，普通账户只有读取能力，未完成精确身份记录与外层进程监管前不能启动任何测试。
    $control = Join-Path $OutputRoot 'control'
    $controlDenied = $false
    try { [IO.File]::WriteAllText((Join-Path $control 'child-write-must-fail'), 'denied') }
    catch [UnauthorizedAccessException] { $controlDenied = $true }
    if (!$controlDenied) { throw 'NATIVE_START_GATE_MUST_BE_PARENT_CONTROLLED' }
    $gatePath = Join-Path $control 'release.json'
    $gateDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while (!(Test-Path -LiteralPath $gatePath)) {
        if ([DateTime]::UtcNow -ge $gateDeadline) { throw 'NATIVE_START_GATE_TIMEOUT' }
        Start-Sleep -Milliseconds 100
    }
    $gate = Get-Content -LiteralPath $gatePath -Raw | ConvertFrom-Json
    $selfTime = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc().ToString()
    if ($gate.source -ne $Source -or $gate.sid -ne $ExpectedSid -or $gate.processId -ne $PID -or
        $gate.creationTime -ne $selfTime -or $gate.runId -ne $env:GITHUB_RUN_ID -or
        $gate.runAttempt -ne $env:GITHUB_RUN_ATTEMPT) { throw 'NATIVE_START_GATE_IDENTITY_INVALID' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $sid = $identity.User.Value
    $administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $administratorGroup = @($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }).Count -ne 0
    $profileKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid
    $profile = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $profileKey).ProfileImagePath)
    $loaded = Test-Path -LiteralPath ('Registry::HKEY_USERS\' + $sid)
    Write-Record 'standard-user-identity.json' @{
        source = $Source; sid = $sid; tokenOwner = $identity.Owner.Value; administrator = $administrator
        administratorGroup = $administratorGroup
        profileLoaded = $loaded; profile = $profile; workingDirectory = (Get-Location).Path
    }
    if ($sid -ne $ExpectedSid -or $administrator -or $administratorGroup -or
        $identity.Owner.Value -ne $sid -or !$loaded) {
        throw 'NATIVE_STANDARD_USER_IDENTITY_REQUIRED'
    }
    if ((Get-Location).Path -ne (Join-Path $Workspace 'apps/runtime')) {
        throw 'NATIVE_STANDARD_USER_WORKING_DIRECTORY_INVALID'
    }
    # 子进程环境指向系统实际加载的当前账户档案，避免继承管理员目录后把其他身份的凭据位置误当作本次验收。
    $env:USERPROFILE = $profile
    $env:USERNAME = $identity.Name.Split('\')[-1]
    $env:LOCALAPPDATA = Join-Path $profile 'AppData/Local'
    $env:APPDATA = Join-Path $profile 'AppData/Roaming'
    $env:TEMP = Join-Path $OutputRoot 'fixtures'
    $env:TMP = $env:TEMP
    $env:VERIQ_NATIVE_EVIDENCE = $EvidenceDirectory
    New-Item -ItemType Directory -Path $env:TEMP | Out-Null
    $probe = Join-Path $Workspace ('.veriq-standard-user-write-probe-' + [guid]::NewGuid().ToString('N'))
    $denied = $false
    try { [IO.File]::WriteAllText($probe, 'must be denied') }
    catch [UnauthorizedAccessException] { $denied = $true }
    if (!$denied) { throw 'NATIVE_CHECKOUT_MUST_BE_READ_ONLY' }
    $inputs = Get-Content -LiteralPath (Join-Path $OutputRoot 'readonly-inputs.json') -Raw | ConvertFrom-Json
    # 已有成员只尝试取得写句柄且绝不写入字节，每个源码和构建输入都必须实际拒绝写入，不能仅凭根目录规则推断。
    foreach ($inputPath in $inputs) {
        $writable = $null
        try {
            $writable = [IO.File]::Open(
                $inputPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        } catch [UnauthorizedAccessException] { continue }
        finally { if ($writable) { $writable.Dispose() } }
        throw 'NATIVE_CHECKOUT_MEMBER_MUST_BE_READ_ONLY'
    }
    $member = Join-Path $env:TEMP 'node-owner-probe.json'
    & $NodePath -e 'require("node:fs").writeFileSync(process.argv[1], "owned fixture", {flag:"wx"})' $member
    if ($LASTEXITCODE -ne 0) { throw 'NATIVE_NODE_OWNER_PROBE_FAILED' }
    $owner = (Get-Acl -LiteralPath $member).GetOwner([Security.Principal.SecurityIdentifier]).Value
    Write-Record 'standard-user-file-owner.json' @{
        source = $Source; sid = $sid; nodeFileOwner = $owner
        checkoutWriteDenied = $denied; readOnlyMembers = @($inputs).Count
    }
    if ($owner -ne $sid) { throw 'NATIVE_NODE_FILE_OWNER_REQUIRED' }
    Write-Record 'standard-user-build-inputs.json' @{ source = $Source; hashes = (Get-BuildHashes) }
    # 完整保留原生及可移植用例选择，真实凭据库、进程监管、联接和权限拒绝均使用普通身份执行，不跳过任何用例。
    $tests = @(
        'tests/native/windows.test.ts', 'tests/native/windows-scheduling.test.ts',
        'tests/native/windows-constructor.test.ts', 'tests/native/windows-response-close.test.ts',
        'tests/native/windows-private-config.test.ts', 'tests/native/windows-profile.test.ts',
        'tests/pipe-framing.test.ts', 'tests/vault-envelope.test.ts', 'tests/vault-integration.test.ts',
        'tests/vault-history.test.ts', 'tests/vault-deletion.test.ts', 'tests/restricted-file.test.ts',
        'tests/restricted-operation.test.ts', 'tests/native/windows-vault.test.ts',
        'tests/native/windows-cookie.test.ts'
    )
    & $NodePath --import tsx --test @tests
    exit $LASTEXITCODE
}

<#
外层作业句柄不继承且关闭即终止整棵进程树，不允许脱离监管；系统进程快照另按账户身份确认没有残留进程。
这里只声明验收监管所需的固定系统调用，类型可独立编译检查，实际作业和账户行为仍必须由真实系统运行证明。
#>
$jobSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public sealed class VeriQNativeJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public uint Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr Minimum, Maximum; public uint ActiveLimit; public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public uint Session, ProcessId; public IntPtr Name, Sid;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(ref SecurityAttributes attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting info,
        uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out ExtendedLimits info,
        uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetHandleInformation(SafeFileHandle job, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision,
        out IntPtr descriptor, IntPtr size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out SafeFileHandle token);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    static extern bool WTSEnumerateProcessesW(IntPtr server, uint reserved, uint version,
        out IntPtr processes, out uint count);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
    readonly SafeFileHandle handle;
    VeriQNativeJob(IntPtr value) { handle = new SafeFileHandle(value, true); }
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static VeriQNativeJob Create(string name, string sid) {
        IntPtr descriptor;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
            "O:" + sid + "D:P(A;;GA;;;" + sid + ")(A;;GA;;;SY)", 1, out descriptor, IntPtr.Zero));
        try {
            var attributes = new SecurityAttributes {
                Length = (uint)Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = 0
            };
            var raw = CreateJobObjectW(ref attributes, name);
            int error = Marshal.GetLastWin32Error();
            if (raw == IntPtr.Zero) throw new Win32Exception(error);
            var job = new VeriQNativeJob(raw);
            try {
                if (error == 183) throw new InvalidOperationException("NATIVE_JOB_ALREADY_EXISTS");
                var limits = new ExtendedLimits();
                limits.Basic.Flags = 0x2000;
                Check(SetInformationJobObject(job.handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()));
                job.VerifyBoundary();
                return job;
            } catch { job.Dispose(); throw; }
        } finally { LocalFree(descriptor); }
    }
    public static VeriQNativeJob Open(string name) {
        var raw = OpenJobObjectW(0x000C, false, name);
        if (raw != IntPtr.Zero) {
            var job = new VeriQNativeJob(raw);
            try { job.VerifyBoundary(); return job; } catch { job.Dispose(); throw; }
        }
        int error = Marshal.GetLastWin32Error();
        if (error == 2) return null;
        throw new Win32Exception(error);
    }
    public uint Active {
        get {
            Accounting info;
            Check(QueryInformationJobObject(handle, 1, out info, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
            return info.Active;
        }
    }
    public void Assign(Process process) { Check(AssignProcessToJobObject(handle, process.Handle)); }
    public void Terminate() { Check(TerminateJobObject(handle, 1)); }
    public uint Flags {
        get {
            ExtendedLimits info;
            Check(QueryInformationJobObject(handle, 9, out info, (uint)Marshal.SizeOf<ExtendedLimits>(), IntPtr.Zero));
            return info.Basic.Flags;
        }
    }
    public bool Inheritable {
        get { uint flags; Check(GetHandleInformation(handle, out flags)); return (flags & 1) != 0; }
    }
    void VerifyBoundary() {
        if (Flags != 0x2000 || Inheritable) throw new InvalidOperationException("NATIVE_JOB_BOUNDARY_INVALID");
    }
    public static string UserSid(Process process) {
        SafeFileHandle token;
        Check(OpenProcessToken(process.Handle, 8, out token));
        using (token) using (var identity = new WindowsIdentity(token.DangerousGetHandle())) {
            return identity.User.Value;
        }
    }
    public static uint[] ProcessesForSid(string sid) {
        IntPtr buffer; uint count;
        Check(WTSEnumerateProcessesW(IntPtr.Zero, 0, 1, out buffer, out count));
        try {
            var result = new List<uint>();
            int size = Marshal.SizeOf<ProcessInfo>();
            for (uint index = 0; index < count; index++) {
                var info = Marshal.PtrToStructure<ProcessInfo>(IntPtr.Add(buffer, checked((int)index * size)));
                if (info.Sid != IntPtr.Zero && new SecurityIdentifier(info.Sid).Value == sid) {
                    result.Add(info.ProcessId);
                }
            }
            return result.ToArray();
        } finally { WTSFreeMemory(buffer); }
    }
    public void Dispose() { handle.Dispose(); }
}
'@
Add-Type -TypeDefinition $jobSource

<#
状态文件在本次运行的独占目录内原子替换且不含口令，目录只允许父身份与系统访问，补偿步骤必须重新校验来源。
#>
function Save-State {
    $temporary = Join-Path $stateDirectory ([guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Depth 8))
    [IO.File]::Move($temporary, $statePath, $true)
}

<#
私有监管目录明确设置拥有者与保护授权，普通账户仅能读取启动闸门，不能伪造状态、提前放行或继承监管句柄。
#>
function Set-ControlAcl([string]$Path, [string]$Reader = '') {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($parentSid))
    foreach ($sid in @($parentSid, 'S-1-5-18')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
            'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    if ($Reader) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($Reader), 'ReadAndExecute',
            'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

<#
补偿只能使用当前运行与当前源码生成的受保护状态，随机名称、账户身份和输出目录必须彼此吻合且没有重解析。
#>
function Assert-StateContainer {
    foreach ($path in @($stateDirectory, $statePath)) {
        if ((Test-Path -LiteralPath $path) -and
            ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'NATIVE_CLEANUP_STATE_REPARSE_REJECTED'
        }
    }
    $acl = Get-Acl -LiteralPath $stateDirectory
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 2) { throw 'NATIVE_CLEANUP_STATE_ACL_INVALID' }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -notin @($parentSid, 'S-1-5-18') -or
            $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') {
            throw 'NATIVE_CLEANUP_STATE_ACL_INVALID'
        }
    }
}

<#
账户和作业名称必须由本次随机标识推导，已有同名却不同身份的账户一律拒绝，不能把过期状态当作回收授权。
#>
function Assert-State {
    Assert-StateContainer
    if ($state.schema -ne 1 -or $state.runId -ne $runId -or $state.runAttempt -ne $runAttempt -or
        $state.source -ne $Source -or $state.workspace -ne $Workspace -or $state.evidence -ne $EvidenceDirectory -or
        $state.parentSid -ne $parentSid -or $state.nonce -notmatch '^[a-f0-9]{32}$' -or
        $state.account -ne ('vqnative' + $state.nonce.Substring(0, 10)) -or
        $state.description -ne ('VeriQ native ' + $state.nonce) -or
        $state.outputRoot -ne (Join-Path $env:ProgramData ('VeriQ-native-' + $state.nonce)) -or
        $state.jobName -ne ('Local\VeriQ-native-' + $runId + '-' + $runAttempt + '-' + $state.nonce)) {
        throw 'NATIVE_CLEANUP_STATE_IDENTITY_INVALID'
    }
    foreach ($path in @($stateDirectory, $statePath, $state.outputRoot)) {
        if ((Test-Path -LiteralPath $path) -and
            ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'NATIVE_CLEANUP_STATE_REPARSE_REJECTED'
        }
    }
    if ($state.sid) {
        if ($state.sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'NATIVE_CLEANUP_SID_INVALID' }
        $accountNow = Get-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($state.sid)) `
            -ErrorAction SilentlyContinue
        if ($accountNow -and ($accountNow.Name -ne $state.account -or
            $accountNow.Description -ne $state.description)) { throw 'NATIVE_CLEANUP_ACCOUNT_IDENTITY_INVALID' }
        $namedAccount = Get-LocalUser -Name $state.account -ErrorAction SilentlyContinue
        if ($namedAccount -and $namedAccount.SID.Value -ne $state.sid) {
            throw 'NATIVE_CLEANUP_ACCOUNT_NAME_REUSED'
        }
    } elseif (Get-LocalUser -Name $state.account -ErrorAction SilentlyContinue) {
        throw 'NATIVE_CLEANUP_UNRECORDED_ACCOUNT'
    }
}

<#
终止前用持有句柄核对根进程完整创建时间和账户身份，未纳入作业的根只能在启动闸门尚未放行时单独终止。
#>
function Stop-OwnedExecution {
    $openedJob = $null
    $rootProcess = $null
    $forced = $false
    try {
        if ($state.jobCreated) { $openedJob = [VeriQNativeJob]::Open($state.jobName) }
        if ($state.processId) {
            try { $rootProcess = [Diagnostics.Process]::GetProcessById($state.processId) }
            catch [ArgumentException] { $rootProcess = $null }
        }
        if ($rootProcess -and !$rootProcess.HasExited) {
            if ($rootProcess.StartTime.ToFileTimeUtc().ToString() -ne $state.creationTime -or
                [VeriQNativeJob]::UserSid($rootProcess) -ne $state.sid) {
                throw 'NATIVE_CLEANUP_PROCESS_IDENTITY_INVALID'
            }
            if (!$state.assigned) {
                if ($state.gateReleased) { throw 'NATIVE_CLEANUP_UNCONTROLLED_TREE' }
                $rootProcess.Kill()
                if (!$rootProcess.WaitForExit(30000)) { throw 'NATIVE_CLEANUP_ROOT_NOT_STOPPED' }
                $forced = $true
            } elseif (!$openedJob) { throw 'NATIVE_CLEANUP_JOB_MISSING_WITH_LIVE_ROOT' }
        }
        if ($openedJob -and $openedJob.Active) {
            $openedJob.Terminate()
            $forced = $true
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while ($openedJob.Active) {
                if ([DateTime]::UtcNow -ge $deadline) { throw 'NATIVE_CLEANUP_JOB_NOT_DRAINED' }
                Start-Sleep -Milliseconds 100
            }
        }
        if ($state.sid) {
            $deadline = [DateTime]::UtcNow.AddSeconds(60)
            while (@([VeriQNativeJob]::ProcessesForSid($state.sid)).Count) {
                if ([DateTime]::UtcNow -ge $deadline) { throw 'NATIVE_CLEANUP_SID_PROCESSES_REMAIN' }
                Start-Sleep -Milliseconds 100
            }
        }
        return $forced
    } finally {
        if ($rootProcess) { $rootProcess.Dispose() }
        if ($openedJob) { $openedJob.Dispose() }
    }
}

<#
回收先确认作业与该账户全部进程退出并等待档案卸载，再恢复源目录权限；任何未知身份或未排空状态保留保护。
#>
function Complete-Cleanup {
    Assert-State
    if ($state.cleaned) { return }
    $forced = Stop-OwnedExecution
    $state.forcedTermination = $state.forcedTermination -or $forced
    Save-State
    $profiles = @()
    if ($state.sid) {
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $profiles = @(Get-CimInstance Win32_UserProfile -Filter ("SID='" + $state.sid + "'"))
            if (!@($profiles | Where-Object { $_.Loaded }).Count) { break }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'NATIVE_CLEANUP_PROFILE_STILL_LOADED' }
            Start-Sleep -Milliseconds 100
        } while ($true)
        foreach ($profile in $profiles) {
            $registered = (Get-ItemProperty -LiteralPath (
                'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $state.sid)).ProfileImagePath
            if ($profile.Special -or $profile.SID -ne $state.sid -or !$profile.LocalPath -or
                $profile.LocalPath -ne [Environment]::ExpandEnvironmentVariables($registered)) {
                throw 'NATIVE_CLEANUP_PROFILE_IDENTITY_INVALID'
            }
        }
    }
    if ($state.aclChanged) {
        $acl = Get-Acl -LiteralPath $Workspace
        $section = [Security.AccessControl.AccessControlSections]::Access
        $acl.SetSecurityDescriptorSddlForm($state.originalDacl, $section)
        Set-Acl -LiteralPath $Workspace -AclObject $acl
        if ((Get-Acl -LiteralPath $Workspace).GetSecurityDescriptorSddlForm($section) -ne $state.originalDacl) {
            throw 'NATIVE_SOURCE_ACL_RESTORE_UNCONFIRMED'
        }
    }
    $state.aclRestored = $true
    Save-State
    $userEvidence = Join-Path $state.outputRoot 'evidence'
    if (Test-Path -LiteralPath $userEvidence) {
        foreach ($name in @(
            '', 'standard-user-identity.json', 'standard-user-file-owner.json', 'standard-user-build-inputs.json'
        )) {
            $path = if ($name) { Join-Path $userEvidence $name } else { $userEvidence }
            if (Test-Path -LiteralPath $path) {
                if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw 'NATIVE_CLEANUP_EVIDENCE_REPARSE_REJECTED'
                }
                if ($name) { Copy-Item -LiteralPath $path -Destination $EvidenceDirectory -Force }
            }
        }
    }
    foreach ($profile in $profiles) { $profile | Remove-CimInstance }
    if ($state.sid) {
        if (@(Get-CimInstance Win32_UserProfile -Filter ("SID='" + $state.sid + "'")).Count) {
            throw 'NATIVE_CLEANUP_PROFILE_REMOVAL_UNCONFIRMED'
        }
        $accountSid = [Security.Principal.SecurityIdentifier]::new($state.sid)
        if (Get-LocalUser -SID $accountSid -ErrorAction SilentlyContinue) {
            Remove-LocalUser -SID $accountSid
        }
        if (Get-LocalUser -SID $accountSid -ErrorAction SilentlyContinue) {
            throw 'NATIVE_CLEANUP_ACCOUNT_REMOVAL_UNCONFIRMED'
        }
    }
    if (Test-Path -LiteralPath $state.outputRoot) { Remove-Item -LiteralPath $state.outputRoot -Recurse -Force }
    $state.cleaned = $true
    Save-State
    Write-Record 'standard-user-cleanup.json' @{
        source = $Source; errors = @(); testExitCode = $state.exitCode; sourceAclRestored = $state.aclRestored
        processTreeDrained = $true; sidProcessesRemaining = 0; forcedTermination = $state.forcedTermination
    }
}

$Workspace = (Resolve-Path -LiteralPath $Workspace).Path.TrimEnd('\', '/')
$EvidenceDirectory = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
if ($Mode -ne 'Cleanup') { $NodePath = (Resolve-Path -LiteralPath $NodePath).Path }
$runId = $env:GITHUB_RUN_ID
$runAttempt = $env:GITHUB_RUN_ATTEMPT
$parentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$parentSid = $parentIdentity.User.Value
$parentPrincipal = [Security.Principal.WindowsPrincipal]::new($parentIdentity)
if ($runId -notmatch '^\d+$' -or $runAttempt -notmatch '^\d+$' -or $Source -notmatch '^[a-f0-9]{40}$' -or
    $Source -ne $env:GITHUB_SHA -or $Workspace -ne (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path -or
    !$parentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'NATIVE_HARNESS_RUN_IDENTITY_INVALID'
}
$expectedEvidence = Join-Path $Workspace ('.superpowers/sdd/veriq-1/evidence/t20/native-' + $Source)
if ($EvidenceDirectory -ne [IO.Path]::GetFullPath($expectedEvidence)) { throw 'NATIVE_HARNESS_EVIDENCE_PATH_INVALID' }
$stateDirectory = Join-Path $env:RUNNER_TEMP ('veriq-windows-native-' + $runId + '-' + $runAttempt)
$statePath = Join-Path $stateDirectory 'state.json'
if ($Mode -eq 'Cleanup') {
    if (!(Test-Path -LiteralPath $statePath)) {
        if (Test-Path -LiteralPath $stateDirectory) { throw 'NATIVE_CLEANUP_STATE_MISSING' }
        exit 0
    }
    Assert-StateContainer
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    try { Complete-Cleanup }
    catch {
        Write-Record 'standard-user-cleanup-failure.json' @{ source = $Source; code = 'NATIVE_CLEANUP_UNCONFIRMED' }
        throw
    }
    exit 0
}
if (Test-Path -LiteralPath $stateDirectory) { throw 'NATIVE_HARNESS_STATE_ALREADY_EXISTS' }
New-Item -ItemType Directory -Path $stateDirectory | Out-Null
Set-ControlAcl $stateDirectory
$nonce = [guid]::NewGuid().ToString('N')
$section = [Security.AccessControl.AccessControlSections]::Access
$state = [pscustomobject]@{
    schema = 1; runId = $runId; runAttempt = $runAttempt; source = $Source; workspace = $Workspace
    evidence = $EvidenceDirectory; parentSid = $parentSid; nonce = $nonce
    account = 'vqnative' + $nonce.Substring(0, 10)
    description = 'VeriQ native ' + $nonce; sid = ''
    outputRoot = Join-Path $env:ProgramData ('VeriQ-native-' + $nonce)
    jobName = 'Local\VeriQ-native-' + $runId + '-' + $runAttempt + '-' + $nonce
    jobCreated = $false; processId = 0; creationTime = ''; assigned = $false; gateReleased = $false
    originalDacl = (Get-Acl -LiteralPath $Workspace).GetSecurityDescriptorSddlForm($section)
    aclChanged = $false; aclRestored = $false; forcedTermination = $false; cleaned = $false; exitCode = 1
}
Save-State
$before = Get-BuildHashes
$job = $null
$child = $null
$password = [Security.SecureString]::new()
try {
    $job = [VeriQNativeJob]::Create($state.jobName, $parentSid)
    $state.jobCreated = $true
    Save-State
    # 密码学随机字符逐一加入安全字符串，口令仅在内存中交给账户登录接口，不转换成明文、不进入参数或环境文件。
    foreach ($character in 'aZ9!'.ToCharArray()) { $password.AppendChar($character) }
    $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#%+-_'
    for ($index = 0; $index -lt 40; $index++) {
        $password.AppendChar($alphabet[[Security.Cryptography.RandomNumberGenerator]::GetInt32($alphabet.Length)])
    }
    $password.MakeReadOnly()
    $user = New-LocalUser -Name $state.account -Password $password -Description $state.description
    $state.sid = $user.SID.Value
    Save-State
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')) -Member $user
    $OutputRoot = $state.outputRoot
    New-Item -ItemType Directory -Path $OutputRoot | Out-Null
    Set-ControlAcl $OutputRoot
    $outputAcl = Get-Acl -LiteralPath $OutputRoot
    $outputAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $OutputRoot -AclObject $outputAcl
    $control = Join-Path $OutputRoot 'control'
    New-Item -ItemType Directory -Path $control | Out-Null
    Set-ControlAcl $control $state.sid
    $tracked = @(& git -C $Workspace -c core.quotepath=false ls-files)
    if ($LASTEXITCODE -ne 0 -or !$tracked.Count) { throw 'NATIVE_SOURCE_LIST_UNAVAILABLE' }
    $inputs = @($tracked | ForEach-Object { Join-Path $Workspace $_ }) + @($PSCommandPath, $NodePath)
    $inputs += @(Get-ChildItem -LiteralPath (Join-Path $Workspace 'apps/runtime/build') -File -Recurse |
        ForEach-Object { $_.FullName })
    ConvertTo-Json -InputObject $inputs |
        Set-Content -LiteralPath (Join-Path $OutputRoot 'readonly-inputs.json') -Encoding utf8
    $readAcl = Get-Acl -LiteralPath $Workspace
    # 源码根仅为新建身份增加读取与禁止修改规则，既有其他身份授权保持原样，退出时恢复并核对原根访问控制描述。
    $readAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user.SID, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    $readAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user.SID, 'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership',
        'ContainerInherit,ObjectInherit', 'None', 'Deny'))
    $state.aclChanged = $true
    Save-State
    Set-Acl -LiteralPath $Workspace -AclObject $readAcl
    $userEvidence = Join-Path $OutputRoot 'evidence'
    New-Item -ItemType Directory -Path $userEvidence | Out-Null
    $parameters = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $PSCommandPath, '-Mode', 'Child',
        '-Workspace', $Workspace, '-EvidenceDirectory', $userEvidence, '-NodePath', $NodePath,
        '-Source', $Source, '-ExpectedSid', $state.sid, '-OutputRoot', $OutputRoot
    )
    # 启动接口会拼接参数列表，因此每个无秘密的路径都显式加引号并拒绝嵌入引号或换行，口令只存在凭据对象中。
    foreach ($value in $parameters) {
        if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) {
            throw 'NATIVE_HARNESS_ARGUMENT_INVALID'
        }
    }
    $arguments = ($parameters | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $credential = [Management.Automation.PSCredential]::new($env:COMPUTERNAME + '\' + $state.account, $password)
    $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $arguments -Credential $credential `
        -LoadUserProfile -WorkingDirectory (Join-Path $Workspace 'apps/runtime') -PassThru `
        -RedirectStandardOutput (Join-Path $EvidenceDirectory 'windows-native.log') `
        -RedirectStandardError (Join-Path $EvidenceDirectory 'windows-native-stderr.log')
    $state.processId = $child.Id
    $state.creationTime = $child.StartTime.ToFileTimeUtc().ToString()
    if ([VeriQNativeJob]::UserSid($child) -ne $state.sid) { throw 'NATIVE_STARTED_PROCESS_SID_INVALID' }
    Save-State
    $job.Assign($child)
    $state.assigned = $true
    Save-State
    Write-Record 'standard-user-process.json' @{
        source = $Source; runId = $runId; runAttempt = $runAttempt; sid = $state.sid
        processId = $state.processId; creationTime = $state.creationTime; jobName = $state.jobName
        assigned = $state.assigned; jobFlags = $job.Flags; jobHandleInherited = $job.Inheritable
    }
    $state.gateReleased = $true
    Save-State
    $gate = @{
        source = $Source; sid = $state.sid; processId = $state.processId; creationTime = $state.creationTime
        runId = $runId; runAttempt = $runAttempt
    }
    [IO.File]::WriteAllText((Join-Path $control 'release.json'), ($gate | ConvertTo-Json))
    $deadline = [DateTime]::UtcNow.AddMinutes(25)
    while (!$child.WaitForExit(1000)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'NATIVE_TEST_TIME_BUDGET_EXHAUSTED' }
    }
    $state.exitCode = $child.ExitCode
    Save-State
    $after = Get-BuildHashes
    if ($before.Count -ne $after.Count -or @($before.Keys | Where-Object { $before[$_] -ne $after[$_] }).Count) {
        throw 'NATIVE_BUILD_INPUTS_CHANGED'
    }
} finally {
    try {
        if ($child) { $child.Dispose() }
        Complete-Cleanup
    } catch {
        Write-Record 'standard-user-cleanup-failure.json' @{ source = $Source; code = 'NATIVE_CLEANUP_UNCONFIRMED' }
        throw
    } finally {
        if ($job) { $job.Dispose() }
        $password.Dispose()
    }
}
foreach ($name in @('windows-native.log', 'windows-native-stderr.log')) {
    $path = Join-Path $EvidenceDirectory $name
    if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path }
}
if ($state.forcedTermination -and $state.exitCode -eq 0) { throw 'NATIVE_TEST_TREE_NOT_DRAINED' }
exit $state.exitCode
