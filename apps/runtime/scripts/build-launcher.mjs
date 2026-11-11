// Build-time only. Installed Agents require this precompiled Linux helper and never run cc.
import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform!=='linux')throw new Error('UNSUPPORTED_LAUNCHER_BUILD_PLATFORM');
const root=new URL('../',import.meta.url);
await mkdir(new URL('build/',root),{recursive:true});
execFileSync('cc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-D_FORTIFY_SOURCE=2','-fstack-protector-strong','-Wl,-z,relro,-z,now','-o',fileURLToPath(new URL('build/veriq_runner',root)),fileURLToPath(new URL('native/linux-runner.c',root))],{stdio:'inherit'});
