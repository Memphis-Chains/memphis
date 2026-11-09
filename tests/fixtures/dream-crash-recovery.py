import json,os,pathlib,select,sqlite3,subprocess,tempfile,time
BASE=pathlib.Path(tempfile.mkdtemp(prefix='memphis-dream-crash-'))
WORK=str(pathlib.Path(__file__).resolve().parents[2])
PATCH=str(pathlib.Path(__file__).with_name('dream-crash-patch.mjs'))
BRIDGE=os.environ.get('MEMPHIS_TEST_NATIVE_BRIDGE',str(pathlib.Path(WORK)/'crates'/'memphis-napi'))
SETUP="""import {createHash} from 'node:crypto';import {saveOperatorConfig,hashWithSalt} from './src/infra/auth/operator-gate.ts';import {generateSoulManifest,writeSoulManifest} from './src/soul/manifest.ts';import {emptySoulMemory,writeSoulMemory} from './src/soul/memory.ts';import {createProposal,transitionProposal} from './src/cognitive/dreaming/proposal-lifecycle.ts';import {appendProposal} from './src/cognitive/dreaming/proposal-chain.ts';import {approveDreamProposal} from './src/cognitive/dreaming/operator-approval.ts';const salt='synthetic';saveOperatorConfig({schemaVersion:1,passphraseHash:hashWithSalt('synthetic-pass',salt),salt,createdAt:'',updatedAt:'',recoveryQuestionHint:'',recoveryHash:''});const m=generateSoulManifest();m.evolution.requirePassphraseForTier2=true;m.evolution.passphraseHash=createHash('sha256').update('synthetic-tier2').digest('hex');writeSoulManifest(m);writeSoulMemory(emptySoulMemory());const p=createProposal({id:'reflection:'+ 'a'.repeat(64),kind:'memory.update',target:{scope:'soul-memory'},patch:{self:{learnings:['synthetic learning']}},evidence:[{sessionId:'chain:journal',sequence:5,quote:'fixture'}],prevalence:{occurrences:1,sessions:1,spanDays:1,denominator:1},confidence:0,rationale:'fixture',proposer:'agent',basedOn:{sessionIds:[],chainBlockHashes:['b'.repeat(64)]}});await appendProposal(p);approveDreamProposal(p,'synthetic-pass','synthetic-tier2');await appendProposal(transitionProposal(p,'accepted'));"""
APPLY="""import {readProposals} from './src/cognitive/dreaming/proposal-chain.ts';import {applyDreamSoulProposal} from './src/cognitive/dreaming/soul-proposal-application.ts';const p=(await readProposals())[0];console.log('RESULT:'+await applyDreamSoulProposal(p));"""
RECON="""import {readProposals} from './src/cognitive/dreaming/proposal-chain.ts';import {reconcileDreamSoulProposal} from './src/cognitive/dreaming/soul-proposal-application.ts';const p=(await readProposals())[0];console.log('RESULT:'+await reconcileDreamSoulProposal(p,'synthetic-pass','synthetic-tier2'));"""
CHAIN="""import {readProposals} from './src/cognitive/dreaming/proposal-chain.ts';console.log('STATUS:'+(await readProposals())[0].status);"""
def run_node(code,env,patch=False):
 args=['node']
 if patch: args+=['--import',PATCH]
 args+=['--import','tsx','--input-type=module','-e',code]
 return subprocess.run(args,cwd=WORK,env=env,capture_output=True,text=True,timeout=25)
out=[]
for backend in ('false','true'):
 for phase in ('before','after','before-chain','after-chain'):
  case=BASE/(backend+'-'+phase);case.mkdir();data=case/'data';data.mkdir();assert data.resolve().is_relative_to(BASE.resolve())
  # The PATH is inherited, not hardcoded to /usr/bin:/bin. On a GitHub
  # runner `node` lives in the hosted tool cache (/opt/hostedtoolcache/...),
  # not in /usr/bin, so the hardcoded PATH made every subprocess fail with
  # "No such file or directory: 'node'". The fixture needs a controlled
  # environment, not a controlled PATH: HOME, the data directory and the
  # runtime root are what make it hermetic.
  env={'HOME':str(case),'PATH':os.environ.get('PATH',os.defpath),'NODE_ENV':'test','MEMPHIS_DATA_DIR':str(data),'MEMPHIS_HOME':str(data),'MEMPHIS_RUNTIME_ROOT':WORK,'MEMPHIS_ENV_FILE':'/tmp/no-env-file','RUST_CHAIN_BRIDGE_PATH':BRIDGE,'RUST_CHAIN_ENABLED':backend}
  setup=run_node(SETUP,env);assert setup.returncode==0,setup.stderr[-500:]
  child=subprocess.Popen(['node','--import',PATCH,'--import','tsx','--input-type=module','-e',APPLY],cwd=WORK,env={**env,'MEMPHIS_SYNTHETIC_CRASH_POINT':phase},stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  seen=b'';deadline=time.monotonic()+20
  while b'SYNTHETIC_RENAME_HIT' not in seen and child.poll() is None and time.monotonic()<deadline:
   if select.select([child.stdout],[],[],.1)[0]:seen+=os.read(child.stdout.fileno(),4096)
  assert b'SYNTHETIC_RENAME_HIT' in seen,(child.poll(),seen[-300:])
  child.kill();child.communicate(timeout=5)
  db=data/'state'/'dream-approvals.sqlite'
  with sqlite3.connect(db) as c: state=c.execute('select status from dream_soul_applications').fetchone()[0]
  mem=data/'config'/'soul-memory.json'
  before=json.loads(mem.read_text())['self']['learnings']
  lock=data/'config'/'soul-memory.json.lock'
  if phase in ('before','after'):
   assert not lock.exists() and state=='staged'
   assert (data/'config'/'soul-memory.json.lock.sqlite').is_file()
   rec=run_node(RECON,env);assert rec.returncode==0,rec.stderr[-500:]
   expected='not-applied' if phase=='before' else 'applied'
   assert 'RESULT:'+expected in rec.stdout,rec.stdout[-300:]
  else:
   assert not lock.exists() and state=='applied',(backend,phase,lock.exists(),state,before)
   chain=run_node(CHAIN,env);assert chain.returncode==0,chain.stderr[-500:]
   expected='accepted' if phase=='before-chain' else 'applied'
   assert 'STATUS:'+expected in chain.stdout,chain.stdout[-300:]
  oldbytes=mem.read_bytes()
  applied=run_node(APPLY,env);assert applied.returncode==0,applied.stderr[-500:]
  expected2='applied' if phase=='before' else 'already-applied'
  assert 'RESULT:'+expected2 in applied.stdout,applied.stdout[-300:]
  after=json.loads(mem.read_text())['self']['learnings'];assert after==['synthetic learning']
  if phase!='before':assert oldbytes==mem.read_bytes(),'replayed a completed mutation'
  out.append({'backend':'napi' if backend=='true' else 'typescript','killed':phase,'journal_before':state,'memory_before_reconcile':before,'reconcile':expected,'retry':expected2,'retained':after})
print(json.dumps(out))
