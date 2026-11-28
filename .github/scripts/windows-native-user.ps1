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
附加观察的读取与保存必须全部隔离失败，连固定回退记录也不能覆盖原拒绝；真正的权限设置和强断言不经过此入口。
#>
function Write-Observation([string]$Name, [scriptblock]$Observe) {
    try {
        $value = & $Observe
        Write-Record $Name $value
    } catch {
        try { Write-Record $Name @{ source = $Source; observationAvailable = $false } }
        catch {}
    }
}

<#
权限诊断只读取本次选定对象的拥有者与有限访问项，不记录文件正文或账户口令，诊断失败也不能替换原拒绝错误。
#>
function Get-AclObservation([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    return @{
        owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        protected = $acl.AreAccessRulesProtected; ruleCount = $rules.Count
        rules = @($rules | Select-Object -First 16 | ForEach-Object {
            @{
                sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights
                allow = $_.AccessControlType -eq 'Allow'; inherited = $_.IsInherited
                inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags
            }
        })
    }
}

<#
恢复判断只接受原始有序访问项和保护请求位完全保留，系统可单向增加自动继承回执，重复或未知标志一律拒绝。
#>
function Compare-SourceDacl([string]$Expected, [string]$Actual) {
    $result = @{
        accepted = $false; exactlyRestored = $false; autoInheritanceApplied = $false
        protectedAndRequestMatched = $false; orderedAcesMatched = $false
        expectedFlags = ''; actualFlags = ''
    }
    $pattern = '\AD:(?<flags>P?(?:AR)?(?:AI)?)(?<aces>(?:\(.*\))?)\z'
    $expectedParts = [regex]::Match($Expected, $pattern, [Text.RegularExpressions.RegexOptions]::Singleline)
    $actualParts = [regex]::Match($Actual, $pattern, [Text.RegularExpressions.RegexOptions]::Singleline)
    if (!$expectedParts.Success -or !$actualParts.Success) { return $result }
    $expectedFlags = $expectedParts.Groups['flags'].Value
    $actualFlags = $actualParts.Groups['flags'].Value
    $expectedAuto = $expectedFlags.EndsWith('AI')
    $actualAuto = $actualFlags.EndsWith('AI')
    $expectedBase = if ($expectedAuto) { $expectedFlags.Substring(0, $expectedFlags.Length - 2) } else {
        $expectedFlags
    }
    $actualBase = if ($actualAuto) { $actualFlags.Substring(0, $actualFlags.Length - 2) } else { $actualFlags }
    $result.expectedFlags = $expectedFlags
    $result.actualFlags = $actualFlags
    $result.protectedAndRequestMatched = [string]::Equals($expectedBase, $actualBase, [StringComparison]::Ordinal)
    $result.orderedAcesMatched = [string]::Equals(
        $expectedParts.Groups['aces'].Value, $actualParts.Groups['aces'].Value, [StringComparison]::Ordinal)
    $result.exactlyRestored = [string]::Equals($Expected, $Actual, [StringComparison]::Ordinal)
    $result.autoInheritanceApplied = !$expectedAuto -and $actualAuto
    $result.accepted = $result.protectedAndRequestMatched -and $result.orderedAcesMatched -and
        ($result.exactlyRestored -or $result.autoInheritanceApplied)
    return $result
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

<#
边界检查使用当前普通身份的真实令牌评价对象删除权与父目录删除子项权，不根据叶文件只读授权推断整条祖先安全。
#>
function Assert-ControlledPaths {
    $pathAccessSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class VeriQNativePathAccess {
    [StructLayout(LayoutKind.Sequential)] struct Mapping {
        public uint Read, Write, Execute, All;
    }
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateToken(IntPtr token, int level, out SafeAccessTokenHandle duplicate);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AccessCheck(byte[] descriptor, SafeAccessTokenHandle token, uint access,
        ref Mapping mapping, IntPtr privileges, ref uint privilegeBytes, out uint granted, out bool allowed);
    public static bool Allowed(byte[] descriptor, uint access) {
        using (var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query | TokenAccessLevels.Duplicate)) {
            SafeAccessTokenHandle token;
            if (!DuplicateToken(identity.AccessToken.DangerousGetHandle(), 2, out token)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            using (token) {
                var mapping = new Mapping { Read = 0x120089, Write = 0x120116, Execute = 0x1200A0, All = 0x1F01FF };
                IntPtr privileges = Marshal.AllocHGlobal(4096);
                try {
                    uint bytes = 4096, granted; bool allowed;
                    if (!AccessCheck(descriptor, token, access, ref mapping, privileges, ref bytes,
                        out granted, out allowed)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    return allowed && (granted & access) == access;
                } finally { Marshal.FreeHGlobal(privileges); }
            }
        }
    }
}
'@
    Add-Type -TypeDefinition $pathAccessSource
    $manifest = Get-Content -LiteralPath (Join-Path $OutputRoot 'control/boundaries.json') -Raw | ConvertFrom-Json
    if ($manifest.source -cne $Source -or $manifest.sid -cne $ExpectedSid -or
        @($manifest.checks).Count -lt 1 -or @($manifest.checks).Count -gt 32) {
        throw 'NATIVE_PATH_BOUNDARY_MANIFEST_INVALID'
    }
    $observed = [Collections.Generic.List[object]]::new()
    $replaceable = $false
    foreach ($check in $manifest.checks) {
        $descriptor = [Convert]::FromBase64String($check.descriptor)
        $parentDescriptor = [Convert]::FromBase64String($check.parentDescriptor)
        $canDelete = [VeriQNativePathAccess]::Allowed($descriptor, 0x10000)
        $parentCanDeleteChild = [VeriQNativePathAccess]::Allowed($parentDescriptor, 0x40)
        $canChangePermissions = [VeriQNativePathAccess]::Allowed($descriptor, 0x40000)
        $canTakeOwnership = [VeriQNativePathAccess]::Allowed($descriptor, 0x80000)
        $parentCanChangePermissions = [VeriQNativePathAccess]::Allowed($parentDescriptor, 0x40000)
        $parentCanTakeOwnership = [VeriQNativePathAccess]::Allowed($parentDescriptor, 0x80000)
        $observed.Add(@{
            path = $check.path; parent = $check.parent; canDelete = $canDelete
            parentCanDeleteChild = $parentCanDeleteChild
            canChangePermissions = $canChangePermissions; canTakeOwnership = $canTakeOwnership
            parentCanChangePermissions = $parentCanChangePermissions; parentCanTakeOwnership = $parentCanTakeOwnership
        })
        if ($canDelete -or $parentCanDeleteChild -or $canChangePermissions -or $canTakeOwnership -or
            $parentCanChangePermissions -or $parentCanTakeOwnership) { $replaceable = $true }
    }
    if ($replaceable) {
        Write-Observation 'standard-user-path-boundaries.json' {
            @{ source = $Source; sid = $ExpectedSid; checks = $observed.ToArray(); replaceable = $true }
        }
        throw 'NATIVE_CONTROLLED_ANCESTOR_REPLACEABLE'
    }
    Write-Record 'standard-user-path-boundaries.json' @{
        source = $Source; sid = $ExpectedSid; checks = $observed.ToArray(); replaceable = $false
    }
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
    Assert-ControlledPaths
    # 子进程环境指向系统实际加载的当前账户档案，避免继承管理员目录后把其他身份的凭据位置误当作本次验收。
    $env:USERPROFILE = $profile
    $env:USERNAME = $identity.Name.Split('\')[-1]
    $env:LOCALAPPDATA = Join-Path $profile 'AppData/Local'
    $env:APPDATA = Join-Path $profile 'AppData/Roaming'
    $env:TEMP = Join-Path $OutputRoot 'fixtures'
    $env:TMP = $env:TEMP
    $env:VERIQ_NATIVE_EVIDENCE = $EvidenceDirectory
    $env:PATH = (Split-Path -Parent $NodePath) + ';' + $env:PATH
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
        Write-Observation 'standard-user-readonly-failure.json' {
            $memberName = if ($inputPath -eq $NodePath) { 'node' } else {
                $inputPath.Substring($Workspace.Length).TrimStart('\', '/')
            }
            @{
                source = $Source; code = 'NATIVE_CHECKOUT_MEMBER_MUST_BE_READ_ONLY'
                member = $memberName; acl = (Get-AclObservation $inputPath)
            }
        }
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
回收只对本次合成夹具使用备份意图句柄，逐级相对打开并核对真实拥有者，任何链接仅删除自身而不读取或改写目标。
#>
function Initialize-CleanupAccess {
    if ('VeriQNativeCleanup' -as [type]) { return }
    $cleanupSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
public static class VeriQNativeCleanup {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeName {
        public ushort Length, MaximumLength; public IntPtr Buffer;
    }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
        public int Length; public IntPtr Root, Name; public uint Attributes;
        public IntPtr Security, Quality;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)] struct Privilege {
        public uint Count, Low; public int High; public uint Attributes;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision,
        out IntPtr descriptor, IntPtr size);
    [DllImport("ntdll.dll")]
    static extern int NtCreateFile(out SafeFileHandle file, uint access, ref ObjectAttributes attributes,
        out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition,
        uint options, IntPtr ea, uint eaLength);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, IntPtr buffer, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, byte[] buffer, uint bytes);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle file, int kind, uint requested, out IntPtr owner,
        out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint SetSecurityInfo(SafeFileHandle file, int kind, uint requested, byte[] owner,
        IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateTokenEx(SafeAccessTokenHandle token, uint access, IntPtr attributes,
        int level, int kind, out SafeAccessTokenHandle duplicate);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LookupPrivilegeValueW(string system, string name, out long luid);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(SafeAccessTokenHandle token, bool disableAll, ref Privilege privilege,
        uint bytes, IntPtr previous, IntPtr required);
    static void Require(bool value, string category) {
        if (!value) throw new InvalidOperationException(category);
    }
    static void Check(bool value) {
        if (!value) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    static void Enable(SafeAccessTokenHandle token, string name) {
        long luid; Check(LookupPrivilegeValueW(null, name, out luid));
        var privilege = new Privilege { Count = 1, Low = (uint)luid, High = (int)(luid >> 32), Attributes = 2 };
        Check(AdjustTokenPrivileges(token, false, ref privilege, 0, IntPtr.Zero, IntPtr.Zero));
        Require(Marshal.GetLastWin32Error() == 0, "NATIVE_CLEANUP_PRIVILEGE_NOT_HELD");
    }
    static void Privileged(string parent, Action action) {
        using (var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query | TokenAccessLevels.Duplicate)) {
            Require(identity.User.Value == parent, "NATIVE_CLEANUP_PARENT_TOKEN_MISMATCH");
            SafeAccessTokenHandle duplicate;
            Check(DuplicateTokenEx(identity.AccessToken, 0x2C, IntPtr.Zero, 2, 2, out duplicate));
            using (duplicate) {
                Enable(duplicate, "SeBackupPrivilege"); Enable(duplicate, "SeRestorePrivilege");
                try { WindowsIdentity.RunImpersonated(duplicate, action); }
                finally {
                    using (var restored = WindowsIdentity.GetCurrent()) {
                        Require(restored.User.Value == parent, "NATIVE_CLEANUP_PARENT_TOKEN_NOT_RESTORED");
                    }
                }
            }
        }
    }
    static void Scope(string root, string scope) {
        var expectedParent = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        Require(Path.GetFullPath(root) == root && Path.GetDirectoryName(root) == expectedParent &&
            Regex.IsMatch(Path.GetFileName(root), "\\AVeriQ-native-[a-f0-9]{32}\\z"),
            "NATIVE_CLEANUP_ROOT_SCOPE_INVALID");
        Require(scope == "fixtures" || scope == "cleanup-proof" || scope == "evidence" ||
            scope == "runtime" || scope == "control" || scope == "readonly-inputs.json",
            "NATIVE_CLEANUP_CHILD_SCOPE_INVALID");
    }
    static uint Attributes(SafeFileHandle file) {
        IntPtr buffer = Marshal.AllocHGlobal(8);
        try {
            Check(GetFileInformationByHandleEx(file, 9, buffer, 8));
            return unchecked((uint)Marshal.ReadInt32(buffer));
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void Owner(SafeFileHandle file, string user, string parent) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(file, 1, 1, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            string sid = new SecurityIdentifier(owner).Value;
            Require(sid == user || sid == parent, "NATIVE_CLEANUP_UNKNOWN_OWNER");
        } finally { LocalFree(descriptor); }
    }
    static SafeFileHandle Root(string root, string parent) {
        var file = CreateFileW(root, 0x130081, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (file.IsInvalid) { file.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        try {
            Owner(file, parent, parent);
            Require((Attributes(file) & 0x410) == 0x10, "NATIVE_CLEANUP_ROOT_REPARSE_REJECTED");
            return file;
        } catch { file.Dispose(); throw; }
    }
    static SafeFileHandle Relative(SafeFileHandle parent, string name, bool writeOwner = false,
        IntPtr security = default(IntPtr), bool create = false) {
        Require(name.Length > 0 && name.Length <= 255 && name != "." && name != ".." &&
            name.IndexOfAny(new[] { '\\', '/', ':', '\0' }) < 0, "NATIVE_CLEANUP_COMPONENT_INVALID");
        IntPtr text = Marshal.StringToHGlobalUni(name), structure = IntPtr.Zero;
        try {
            var unicode = new UnicodeName {
                Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)(name.Length * 2)),
                Buffer = text
            };
            structure = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeName>());
            Marshal.StructureToPtr(unicode, structure, false);
            var attributes = new ObjectAttributes {
                Length = Marshal.SizeOf<ObjectAttributes>(), Root = parent.DangerousGetHandle(),
                Name = structure, Attributes = 0x40, Security = security
            };
            SafeFileHandle file; IoStatus io;
            uint access = (create ? 0x130196U : 0x130081U) | (writeOwner ? 0x80000U : 0U);
            int status = NtCreateFile(out file, access, ref attributes, out io, IntPtr.Zero, 0, 3, create ? 2U : 1U,
                0x00204020, IntPtr.Zero, 0);
            if (status < 0) { file?.Dispose(); throw new Win32Exception((int)RtlNtStatusToDosError(status)); }
            return file;
        } finally {
            if (structure != IntPtr.Zero) Marshal.FreeHGlobal(structure);
            Marshal.FreeHGlobal(text);
        }
    }
    public static void CreateOutputDirectory(string root, string scope, string user, string parent) {
        Scope(root, scope);
        Require(scope == "cleanup-proof" || scope == "evidence", "NATIVE_CREATE_DIRECTORY_SCOPE_INVALID");
        string sddl = "O:" + parent + "D:P(A;OICI;GA;;;" + parent + ")(A;OICI;GA;;;SY)";
        if (scope == "evidence") sddl += "(A;OICI;0x1301bf;;;" + user + ")";
        IntPtr descriptor;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero));
        try {
            using (var directory = Root(root, parent)) {
                var attributes = new SecurityAttributes {
                    Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = 0
                };
                Check(CreateDirectoryW(Path.Combine(root, scope), ref attributes));
            }
        } finally { LocalFree(descriptor); }
    }
    public static void WriteOutput(string root, string scope, string document, string user, string parent) {
        Scope(root, "control");
        Require(scope == "readonly-inputs.json" || scope == "boundaries.json" || scope == "release-pending.json",
            "NATIVE_CREATE_FILE_SCOPE_INVALID");
        IntPtr descriptor;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:" + parent + "D:P(A;;GA;;;" + parent +
            ")(A;;GA;;;SY)(A;;GRGX;;;" + user + ")", 1, out descriptor, IntPtr.Zero));
        try {
            using (var directory = Root(root, parent)) {
                SafeFileHandle control = null;
                try {
                    if (scope != "readonly-inputs.json") {
                        control = Relative(directory, "control"); Owner(control, parent, parent);
                        Require((Attributes(control) & 0x410) == 0x10, "NATIVE_CREATE_CONTROL_REPARSE_REJECTED");
                    }
                    using (var file = Relative(control ?? directory, scope, false, descriptor, true))
                    using (var stream = new FileStream(file, FileAccess.Write)) {
                        byte[] bytes = new System.Text.UTF8Encoding(false).GetBytes(document);
                        stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
                    }
                } finally { control?.Dispose(); }
            }
        } finally { LocalFree(descriptor); }
    }
    static void ProofAcl(SafeFileHandle file, string parent) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(file, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            Require(new SecurityIdentifier(owner).Value == parent, "NATIVE_CLEANUP_PROOF_OWNER_INVALID");
            uint length = GetSecurityDescriptorLength(descriptor);
            Require(length > 0 && length <= 65536, "NATIVE_CLEANUP_PROOF_ACL_INVALID");
            var bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, checked((int)length));
            var raw = new RawSecurityDescriptor(bytes, 0);
            Require((raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 &&
                raw.DiscretionaryAcl != null && raw.DiscretionaryAcl.Count == 2,
                "NATIVE_CLEANUP_PROOF_ACL_INVALID");
            var expected = new HashSet<string>(new[] { parent, "S-1-5-18" }, StringComparer.Ordinal);
            foreach (GenericAce ace in raw.DiscretionaryAcl) {
                var allow = ace as CommonAce;
                Require(allow != null && allow.AceQualifier == AceQualifier.AccessAllowed &&
                    allow.AceFlags == (AceFlags.ContainerInherit | AceFlags.ObjectInherit) &&
                    allow.AccessMask == 0x1F01FF && expected.Remove(allow.SecurityIdentifier.Value),
                    "NATIVE_CLEANUP_PROOF_ACL_INVALID");
            }
            Require(expected.Count == 0, "NATIVE_CLEANUP_PROOF_ACL_INVALID");
        } finally { LocalFree(descriptor); }
    }
    static SafeFileHandle OptionalRelative(SafeFileHandle parent, string name) {
        try { return Relative(parent, name, true); }
        catch (Win32Exception error) { if (error.NativeErrorCode == 2) return null; throw; }
    }
    static List<string> Names(SafeFileHandle directory) {
        const int capacity = 65536;
        var names = new List<string>(); IntPtr buffer = Marshal.AllocHGlobal(capacity);
        try {
            for (int batch = 0; ; batch++) {
                Require(batch < 4096, "NATIVE_CLEANUP_ENUMERATION_LIMIT");
                if (!GetFileInformationByHandleEx(directory, batch == 0 ? 15 : 14, buffer, capacity)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 18) return names;
                    throw new Win32Exception(error);
                }
                int offset = 0;
                for (;;) {
                    Require(offset >= 0 && offset <= capacity - 68, "NATIVE_CLEANUP_ENUMERATION_INVALID");
                    int next = Marshal.ReadInt32(buffer, offset), length = Marshal.ReadInt32(buffer, offset + 60);
                    Require(length > 0 && length <= 510 && (length & 1) == 0 && offset + 68 + length <= capacity,
                        "NATIVE_CLEANUP_ENUMERATION_INVALID");
                    string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 68), length / 2);
                    if (name != "." && name != "..") names.Add(name);
                    Require(names.Count <= 100000, "NATIVE_CLEANUP_MEMBER_LIMIT");
                    if (next == 0) break;
                    Require(next >= 68 + length && (next & 7) == 0, "NATIVE_CLEANUP_ENUMERATION_INVALID");
                    offset = checked(offset + next);
                }
            }
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void Delete(SafeFileHandle parent, string name, string user, string owner, int depth, ref int count) {
        Require(depth <= 64 && ++count <= 100000, "NATIVE_CLEANUP_TREE_LIMIT");
        using (var file = Relative(parent, name)) {
            Owner(file, user, owner);
            uint attributes = Attributes(file);
            if ((attributes & 0x10) != 0 && (attributes & 0x400) == 0) {
                foreach (string child in Names(file)) Delete(file, child, user, owner, depth + 1, ref count);
            }
            Check(SetFileInformationByHandle(file, 4, new byte[] { 1 }, 1));
        }
    }
    public static int Remove(string root, string scope, string user, string parent) {
        Scope(root, scope); int count = 0;
        Privileged(parent, () => {
            using (var directory = Root(root, parent)) Delete(directory, scope, user, parent, 0, ref count);
        });
        return count;
    }
    static void FreshOwner(SafeFileHandle file, string parent, string tokenOwner, uint kind) {
        Owner(file, parent, tokenOwner);
        Require((Attributes(file) & 0x410) == kind, "NATIVE_CLEANUP_FRESH_PROOF_KIND_INVALID");
        var sid = new SecurityIdentifier(parent); var bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        uint error = SetSecurityInfo(file, 1, 1, bytes, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (error != 0) throw new Win32Exception((int)error);
        Owner(file, parent, parent);
    }
    public static void InitializeFreshProof(string root, string parent) {
        Scope(root, "cleanup-proof"); string tokenOwner;
        using (var identity = WindowsIdentity.GetCurrent()) tokenOwner = identity.Owner.Value;
        Privileged(parent, () => {
            using (var directory = Root(root, parent))
            using (var proof = Relative(directory, "cleanup-proof")) {
                ProofAcl(proof, parent);
                Require((Attributes(proof) & 0x410) == 0x10, "NATIVE_CLEANUP_PROOF_REPARSE_REJECTED");
                using (var external = OptionalRelative(proof, "external")) {
                    if (external != null) {
                        FreshOwner(external, parent, tokenOwner, 0x10);
                        using (var sentinel = OptionalRelative(external, "sentinel.txt")) {
                            if (sentinel != null) FreshOwner(sentinel, parent, tokenOwner, 0);
                        }
                    }
                }
                using (var tree = OptionalRelative(proof, "tree")) {
                    if (tree != null) {
                        FreshOwner(tree, parent, tokenOwner, 0x10);
                        using (var junction = OptionalRelative(tree, "junction")) {
                            if (junction != null) FreshOwner(junction, parent, tokenOwner, 0x410);
                        }
                    }
                }
            }
        });
    }
    public static void Probe(string root, string user, string parent) {
        Scope(root, "cleanup-proof");
        bool rejected = false;
        try { Remove(root, "../external", user, parent); }
        catch (InvalidOperationException error) { rejected = error.Message == "NATIVE_CLEANUP_CHILD_SCOPE_INVALID"; }
        Require(rejected, "NATIVE_CLEANUP_WRONG_SCOPE_NOT_REJECTED");
        rejected = false;
        try { Remove(Path.Combine(root, "fixtures"), "fixtures", user, parent); }
        catch (InvalidOperationException error) { rejected = error.Message == "NATIVE_CLEANUP_ROOT_SCOPE_INVALID"; }
        Require(rejected, "NATIVE_CLEANUP_WRONG_ROOT_NOT_REJECTED");
        Privileged(parent, () => {
            using (var directory = Root(root, parent))
            using (var proof = Relative(directory, "cleanup-proof")) {
                Owner(proof, parent, parent);
                Require((Attributes(proof) & 0x410) == 0x10, "NATIVE_CLEANUP_PROOF_REPARSE_REJECTED");
                bool ownerRejected = false; int rejectedCount = 0;
                try { Delete(proof, "external", user, "S-1-5-18", 0, ref rejectedCount); }
                catch (InvalidOperationException error) {
                    ownerRejected = error.Message == "NATIVE_CLEANUP_UNKNOWN_OWNER";
                }
                Require(ownerRejected, "NATIVE_CLEANUP_UNKNOWN_OWNER_NOT_REJECTED");
                int count = 0; Delete(proof, "tree", user, parent, 0, ref count);
                Require(count == 2, "NATIVE_CLEANUP_JUNCTION_PROBE_COUNT_INVALID");
            }
        });
    }
    public static void RemoveEmptyRoot(string root, string parent) {
        Scope(root, "fixtures");
        Privileged(parent, () => {
            using (var directory = Root(root, parent)) {
                Require(Names(directory).Count == 0, "NATIVE_CLEANUP_UNKNOWN_TOP_LEVEL_MEMBER");
                Check(SetFileInformationByHandle(directory, 4, new byte[] { 1 }, 1));
            }
        });
    }
}
'@
    Add-Type -TypeDefinition $cleanupSource
}

<#
自验目录身份与阶段先保存在监管状态中，再以创建时私有描述符生成目录；恢复只接受同一随机身份且权限完全匹配的残留。
#>
function Start-CleanupProof {
    $proof = Join-Path $state.outputRoot 'cleanup-proof'
    if (Test-Path -LiteralPath $proof) {
        if ($state.cleanupProofNonce -cne $state.nonce -or $state.cleanupProofPhase -notin @('creating', 'active')) {
            throw 'NATIVE_CLEANUP_PROOF_STATE_MISMATCH'
        }
        [VeriQNativeCleanup]::InitializeFreshProof($state.outputRoot, $parentSid)
        $null = [VeriQNativeCleanup]::Remove($state.outputRoot, 'cleanup-proof', $state.sid, $parentSid)
        if (Test-Path -LiteralPath $proof) { throw 'NATIVE_CLEANUP_PROOF_RECOVERY_UNCONFIRMED' }
        $state.cleanupProofRecovered = $true
    }
    $state.cleanupProofNonce = $state.nonce
    $state.cleanupProofPhase = 'creating'
    Save-State
    [VeriQNativeCleanup]::CreateOutputDirectory($state.outputRoot, 'cleanup-proof', $state.sid, $parentSid)
    $state.cleanupProofPhase = 'active'
    Save-State
}

<#
自验成员限定为刚创建的私有监管目录内固定两个子目录和哨兵连接，故障恢复必须经过相同成员构造和真实句柄校验。
#>
function New-CleanupProofMembers {
    $proof = Join-Path $state.outputRoot 'cleanup-proof'
    $external = Join-Path $proof 'external'
    $tree = Join-Path $proof 'tree'
    New-Item -ItemType Directory -Path $external, $tree | Out-Null
    [IO.File]::WriteAllText((Join-Path $external 'sentinel.txt'), 'VeriQ cleanup must preserve this external sentinel.')
    New-Item -ItemType Junction -Path (Join-Path $tree 'junction') -Target $external | Out-Null
}

<#
永久清理自验在本次独占目录内创建外部哨兵与真实目录连接，实际删除后核对正文和完整权限，错范围与未知拥有者必须拒绝。
#>
function Test-CleanupBoundary {
    $proof = Join-Path $state.outputRoot 'cleanup-proof'
    Start-CleanupProof
    if (!$state.cleanupProofRecoveryTested) {
        New-CleanupProofMembers
        # 只捕获此处刻意注入的固定失败，真实文件或身份错误仍外抛；保留注入记录并实际再进入同一补偿路径证明可重入。
        $faultObserved = $false
        try { throw 'NATIVE_CLEANUP_RECOVERY_PROBE_INJECTED' }
        catch {
            if ($_.Exception.Message -cne 'NATIVE_CLEANUP_RECOVERY_PROBE_INJECTED') { throw }
            $faultObserved = $true
        }
        if (!$faultObserved) { throw 'NATIVE_CLEANUP_RECOVERY_PROBE_NOT_OBSERVED' }
        Start-CleanupProof
        if (!$state.cleanupProofRecovered) { throw 'NATIVE_CLEANUP_RECOVERY_PROBE_NOT_RECOVERED' }
        $state.cleanupProofRecoveryTested = $true
        Save-State
        Write-Record 'standard-user-cleanup-recovery.json' @{
            source = $Source; firstFailure = 'NATIVE_CLEANUP_RECOVERY_PROBE_INJECTED'
            protectedStateMatched = $true; repeatedCleanupRecovered = $true
        }
    }
    $external = Join-Path $proof 'external'
    $tree = Join-Path $proof 'tree'
    New-CleanupProofMembers
    $sentinel = Join-Path $external 'sentinel.txt'
    # 父身份默认拥有者也可能是管理员组，只初始化刚创建的四个固定自验成员，链接拥有者只经不跟随句柄设置。
    [VeriQNativeCleanup]::InitializeFreshProof($state.outputRoot, $parentSid)
    $section = [Security.AccessControl.AccessControlSections]::All
    $before = (Get-Acl -LiteralPath $sentinel).GetSecurityDescriptorSddlForm($section)
    $bytes = [IO.File]::ReadAllBytes($sentinel)
    [VeriQNativeCleanup]::Probe($state.outputRoot, $state.sid, $parentSid)
    $after = (Get-Acl -LiteralPath $sentinel).GetSecurityDescriptorSddlForm($section)
    if (![string]::Equals($before, $after, [StringComparison]::Ordinal) -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($sentinel)) -cne [Convert]::ToBase64String($bytes) -or
        (Test-Path -LiteralPath $tree)) { throw 'NATIVE_CLEANUP_EXTERNAL_SENTINEL_CHANGED' }
    $null = [VeriQNativeCleanup]::Remove($state.outputRoot, 'cleanup-proof', $state.sid, $parentSid)
    if (Test-Path -LiteralPath $proof) { throw 'NATIVE_CLEANUP_PROOF_REMOVAL_UNCONFIRMED' }
    $state.cleanupProofPhase = 'complete'
    Save-State
    Write-Record 'standard-user-cleanup-boundaries.json' @{
        source = $Source; externalSentinelContentUnchanged = $true; externalSentinelAclUnchanged = $true
        junctionOnlyUnlinked = $true; wrongScopeRejected = $true; unknownOwnerRejected = $true
        parentTokenRestored = $true
    }
}

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
function Set-ControlAcl(
    [string]$Path, [string]$Reader = '',
    [ValidateSet('', 'state', 'output', 'gate', 'runtime')][string]$Scope = ''
) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
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
    if (!$Scope) {
        $Scope = if ($Path -eq $stateDirectory) { 'state' } elseif ($Reader) { 'gate' } else { 'output' }
    }
    Write-Observation ('standard-user-acl-' + $Scope + '.json') {
        @{ source = $Source; scope = $Scope; acl = (Get-AclObservation $Path) }
    }
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
    Write-Observation 'standard-user-acl-state.json' {
        @{ source = $Source; scope = 'state'; acl = (Get-AclObservation $stateDirectory) }
    }
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
    # 只在完整排空和档案卸载后复制固定证据，使原始失败可独立回查，不能让后续权限恢复错误再次遮住具体成员。
    $userEvidence = Join-Path $state.outputRoot 'evidence'
    if (Test-Path -LiteralPath $userEvidence) {
        foreach ($name in @(
            '', 'standard-user-identity.json', 'standard-user-file-owner.json', 'standard-user-build-inputs.json',
            'standard-user-readonly-failure.json', 'standard-user-path-boundaries.json'
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
    if (Test-Path -LiteralPath $state.outputRoot) {
        Initialize-CleanupAccess
        Test-CleanupBoundary
        $fixtures = Join-Path $state.outputRoot 'fixtures'
        if (Test-Path -LiteralPath $fixtures) {
            $members = [VeriQNativeCleanup]::Remove($state.outputRoot, 'fixtures', $state.sid, $parentSid)
            if (Test-Path -LiteralPath $fixtures) { throw 'NATIVE_CLEANUP_FIXTURES_REMOVAL_UNCONFIRMED' }
            Write-Record 'standard-user-cleanup-fixtures.json' @{
                source = $Source; removedMembers = $members; scope = 'fixtures'; noFollow = $true
                profileUnloaded = $true; sidProcessesRemaining = 0; parentTokenRestored = $true
            }
        }
    }
    if ($state.aclChanged) {
        $acl = Get-Acl -LiteralPath $Workspace
        $section = [Security.AccessControl.AccessControlSections]::Access
        $beforeDacl = $acl.GetSecurityDescriptorSddlForm($section)
        $acl.SetSecurityDescriptorSddlForm($state.originalDacl, $section)
        Set-Acl -LiteralPath $Workspace -AclObject $acl
        $afterDacl = (Get-Acl -LiteralPath $Workspace).GetSecurityDescriptorSddlForm($section)
        $comparison = Compare-SourceDacl $state.originalDacl $afterDacl
        Write-Observation 'standard-user-source-acl.json' {
            @{
                source = $Source; expectedDacl = $state.originalDacl; beforeDacl = $beforeDacl
                afterDacl = $afterDacl; sourceAclExactlyRestored = $comparison.exactlyRestored
                autoInheritanceApplied = $comparison.autoInheritanceApplied
                sourceAclProtectedAndRequestMatched = $comparison.protectedAndRequestMatched
                sourceAclOrderedAcesMatched = $comparison.orderedAcesMatched
                expectedFlags = $comparison.expectedFlags; actualFlags = $comparison.actualFlags
            }
        }
        if (!$comparison.accepted) {
            throw 'NATIVE_SOURCE_ACL_RESTORE_UNCONFIRMED'
        }
        $state.aclExactlyRestored = $comparison.exactlyRestored
        $state.autoInheritanceApplied = $comparison.autoInheritanceApplied
        $state.aclProtectedAndRequestMatched = $comparison.protectedAndRequestMatched
        $state.aclOrderedAcesMatched = $comparison.orderedAcesMatched
    }
    $state.aclRestored = $true
    Save-State
    # 合成输出只接受固定顶层成员并按句柄回收，身份删除放在所有私有夹具之后，避免失败时失去本次拥有者的归属证据。
    if (Test-Path -LiteralPath $state.outputRoot) {
        foreach ($scope in @('evidence', 'runtime', 'control', 'readonly-inputs.json')) {
            if (Test-Path -LiteralPath (Join-Path $state.outputRoot $scope)) {
                $null = [VeriQNativeCleanup]::Remove($state.outputRoot, $scope, $state.sid, $parentSid)
            }
        }
        [VeriQNativeCleanup]::RemoveEmptyRoot($state.outputRoot, $parentSid)
        if (Test-Path -LiteralPath $state.outputRoot) { throw 'NATIVE_CLEANUP_OUTPUT_REMOVAL_UNCONFIRMED' }
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
    $state.cleaned = $true
    Save-State
    Write-Record 'standard-user-cleanup.json' @{
        source = $Source; errors = @(); testExitCode = $state.exitCode; sourceAclRestored = $state.aclRestored
        sourceAclExactlyRestored = $state.aclExactlyRestored; autoInheritanceApplied = $state.autoInheritanceApplied
        sourceAclProtectedAndRequestMatched = $state.aclProtectedAndRequestMatched
        sourceAclOrderedAcesMatched = $state.aclOrderedAcesMatched
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
        $cleanupError = $_
        Write-Observation 'standard-user-cleanup-failure.json' {
            @{ source = $Source; code = 'NATIVE_CLEANUP_UNCONFIRMED' }
        }
        throw $cleanupError
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
    aclExactlyRestored = $false; autoInheritanceApplied = $false
    aclProtectedAndRequestMatched = $false; aclOrderedAcesMatched = $false
    cleanupProofNonce = ''; cleanupProofPhase = ''; cleanupProofRecovered = $false
    cleanupProofRecoveryTested = $false
}
Save-State
$sourceNodePath = $NodePath
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
    # 容器本身不给普通账户删除权限，避免通过重命名祖先替换只读运行目录；可写夹具子项仍继承原有修改能力。
    $outputAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user.SID, 'ReadAndExecute,Write', 'None', 'None', 'Allow'))
    $outputAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'InheritOnly', 'Allow'))
    Set-Acl -LiteralPath $OutputRoot -AclObject $outputAcl
    Write-Observation 'standard-user-acl-output.json' {
        @{ source = $Source; scope = 'output'; acl = (Get-AclObservation $OutputRoot) }
    }
    $control = Join-Path $OutputRoot 'control'
    New-Item -ItemType Directory -Path $control | Out-Null
    Set-ControlAcl $control $state.sid
    # 共享工具缓存已实测允许普通主体写入，因此只复制相同锁定字节到本次只读运行目录，不改变全机工具的权限。
    $runtimeDirectory = Join-Path $OutputRoot 'runtime'
    New-Item -ItemType Directory -Path $runtimeDirectory | Out-Null
    Set-ControlAcl $runtimeDirectory $state.sid 'runtime'
    $privateNode = Join-Path $runtimeDirectory 'node.exe'
    Copy-Item -LiteralPath $NodePath -Destination $privateNode
    $nodeAcl = [Security.AccessControl.FileSecurity]::new()
    $nodeAcl.SetAccessRuleProtection($true, $false)
    $nodeAcl.SetOwner([Security.Principal.SecurityIdentifier]::new($parentSid))
    foreach ($sid in @($parentSid, 'S-1-5-18')) {
        $nodeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow'))
    }
    $nodeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user.SID, 'ReadAndExecute', 'Allow'))
    Set-Acl -LiteralPath $privateNode -AclObject $nodeAcl
    $copyHash = (Get-FileHash -LiteralPath $privateNode -Algorithm SHA256).Hash
    if ($copyHash -cne $before['node'] -or
        (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash -cne $before['node']) {
        throw 'NATIVE_PRIVATE_NODE_BYTES_MISMATCH'
    }
    Write-Record 'standard-user-node-copy.json' @{
        source = $Source; sourceNodeSha256 = $before['node']; copyNodeSha256 = $copyHash
        copyBytes = (Get-Item -LiteralPath $privateNode).Length; acl = (Get-AclObservation $privateNode)
    }
    $NodePath = $privateNode
    $tracked = @(& git -C $Workspace -c core.quotepath=false ls-files)
    if ($LASTEXITCODE -ne 0 -or !$tracked.Count) { throw 'NATIVE_SOURCE_LIST_UNAVAILABLE' }
    $inputs = @($tracked | ForEach-Object { Join-Path $Workspace $_ }) + @($PSCommandPath, $NodePath)
    $inputs += @(Get-ChildItem -LiteralPath (Join-Path $Workspace 'apps/runtime/build') -File -Recurse |
        ForEach-Object { $_.FullName })
    Initialize-CleanupAccess
    [VeriQNativeCleanup]::WriteOutput(
        $OutputRoot, 'readonly-inputs.json', (ConvertTo-Json -InputObject $inputs), $state.sid, $parentSid)
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
    $checks = [Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($leaf in @($privateNode, $stateDirectory, $Workspace)) {
        $current = $leaf
        while ($parent = [IO.Directory]::GetParent($current)) {
            if (!$seen.ContainsKey($current)) {
                foreach ($path in @($current, $parent.FullName)) {
                    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                        throw 'NATIVE_CONTROLLED_ANCESTOR_REPARSE_REJECTED'
                    }
                }
                $checks.Add(@{
                    path = $current; parent = $parent.FullName
                    descriptor = [Convert]::ToBase64String(
                        (Get-Acl -LiteralPath $current).GetSecurityDescriptorBinaryForm())
                    parentDescriptor = [Convert]::ToBase64String(
                        (Get-Acl -LiteralPath $parent.FullName).GetSecurityDescriptorBinaryForm())
                })
                $seen[$current] = $true
            }
            $current = $parent.FullName
        }
    }
    if ($checks.Count -gt 32) { throw 'NATIVE_PATH_BOUNDARY_BUDGET_EXCEEDED' }
    $boundaryManifest = @{ source = $Source; sid = $state.sid; checks = $checks.ToArray() }
    [VeriQNativeCleanup]::WriteOutput(
        $OutputRoot, 'boundaries.json', ($boundaryManifest | ConvertTo-Json -Depth 5), $state.sid, $parentSid)
    $userEvidence = Join-Path $OutputRoot 'evidence'
    [VeriQNativeCleanup]::CreateOutputDirectory($OutputRoot, 'evidence', $state.sid, $parentSid)
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
    [VeriQNativeCleanup]::WriteOutput(
        $OutputRoot, 'release-pending.json', ($gate | ConvertTo-Json), $state.sid, $parentSid)
    [IO.File]::Move((Join-Path $control 'release-pending.json'), (Join-Path $control 'release.json'))
    $deadline = [DateTime]::UtcNow.AddMinutes(25)
    while (!$child.WaitForExit(1000)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'NATIVE_TEST_TIME_BUDGET_EXHAUSTED' }
    }
    $state.exitCode = $child.ExitCode
    if ($state.exitCode -ne 0) {
        Write-Observation 'standard-user-test-exit.json' {
            @{ source = $Source; code = 'NATIVE_CHILD_NONZERO_EXIT'; exitCode = $state.exitCode }
        }
    }
    Save-State
    $after = Get-BuildHashes
    $sourceNodeHashAfter = (Get-FileHash -LiteralPath $sourceNodePath -Algorithm SHA256).Hash
    Write-Record 'standard-user-node-copy.json' @{
        source = $Source; sourceNodeSha256 = $before['node']; copyNodeSha256 = $copyHash
        sourceNodeSha256After = $sourceNodeHashAfter; copyNodeSha256After = $after['node']
        copyBytes = (Get-Item -LiteralPath $privateNode).Length; acl = (Get-AclObservation $privateNode)
    }
    if ($sourceNodeHashAfter -cne $before['node']) { throw 'NATIVE_ORIGINAL_NODE_BYTES_CHANGED' }
    if ($before.Count -ne $after.Count -or @($before.Keys | Where-Object { $before[$_] -ne $after[$_] }).Count) {
        throw 'NATIVE_BUILD_INPUTS_CHANGED'
    }
} catch {
    $originalError = $_
    Write-Observation 'standard-user-harness-failure.json' {
        $category = $originalError.Exception.GetType().FullName
        $code = if ($originalError.Exception.Message -cmatch '^NATIVE_[A-Z0-9_]+$') {
            $originalError.Exception.Message
        } else { 'NATIVE_HARNESS_FAILURE' }
        @{ source = $Source; code = $code; category = $category }
    }
    throw $originalError
} finally {
    try {
        if ($child) { $child.Dispose() }
        Complete-Cleanup
    } catch {
        $cleanupError = $_
        Write-Observation 'standard-user-cleanup-failure.json' {
            @{ source = $Source; code = 'NATIVE_CLEANUP_UNCONFIRMED' }
        }
        throw $cleanupError
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
