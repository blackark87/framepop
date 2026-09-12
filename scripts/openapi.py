"""Generate the implemented API contract, separate from the retained mock."""
import json
from pathlib import Path
S=lambda n:{'$ref':'#/components/schemas/'+n}
obj=lambda p,required=[]:{'type':'object','properties':p,'required':required}
string={'type':'string'};integer={'type':'integer'};boolean={'type':'boolean'}
array=lambda item:{'type':'array','items':item}
assignment=obj({'connectionId':string,'model':string},['connectionId','model'])
schemas={
'Error':obj({'error':obj({'code':string,'message':string},['code','message'])},['error']),
'Assignment':assignment,
'Connection':obj({'id':string,'name':string,'kind':{'enum':['ollama','lmstudio','codex','xai','comfy','openclaw']},'url':{'type':'string','format':'uri'},'token':{'type':'string','writeOnly':True},'hasToken':{'type':'boolean','readOnly':True},'models':array(obj({'id':string,'name':string}))},['id','name','kind']),
'ComfySelection':obj({'connectionId':{'type':['string','null']},'model':{'type':['string','null']},'imageModel':{'type':['string','null']},'loras':{'type':'array','items':string,'uniqueItems':True},'imageLoras':{'type':'array','items':string,'uniqueItems':True}},['connectionId','loras']),
'Settings':obj({'revision':integer,'connections':array(S('Connection')),'assignmentMode':{'enum':['auto','manual']},'primary':{'anyOf':[S('Assignment'),{'type':'null'}]},'roles':{'type':'object','additionalProperties':{'anyOf':[S('Assignment'),{'type':'null'}]}},'comfy':S('ComfySelection'),'enhancementInstruction':string,'qc':obj({'minSimilarity':{'type':'number','minimum':0,'maximum':1},'minSharpness':{'type':'number','exclusiveMinimum':0},'maxBadFraction':{'type':'number','minimum':0,'exclusiveMaximum':1}},['minSimilarity','minSharpness','maxBadFraction'])},['revision','connections','assignmentMode','roles','comfy','enhancementInstruction','qc']),
'Segment':obj({'id':string,'title':string,'prompt':string,'duration':{'type':'integer','minimum':1,'maximum':15},'expectsFaces':boolean,'continuous':boolean},['id','title','prompt','duration']),
'Plan':obj({'segments':array(S('Segment'))},['segments']),
'Project':obj({'id':string,'title':string,'synopsis':string,'modelProfile':string,'duration':{'type':'integer','minimum':1,'maximum':3600},'mode':{'enum':['local','mixed']},'referenceId':{'type':['string','null']},'revision':integer,'approved':boolean,'pendingRevision':boolean,'plan':S('Plan'),'story':obj({'plot':array(obj({'title':string,'text':string})),'story':string})}),
'Constraint':obj({'id':string,'title':string,'prompt':string,'duration':{'type':'integer','minimum':1,'maximum':15},'index':{'type':'integer','minimum':0},'deleted':boolean},['id']),
'JobRequest':obj({'kind':{'enum':['plan','revise','enhance','image','video','recommend']},'projectId':{'type':['string','null']},'input':obj({'constraints':array(S('Constraint')),'target':{'enum':['image','video']},'prompt':string,'profile':string,'name':string,'selection':S('ComfySelection'),'seed':integer})},['kind']),
'Job':obj({'id':string,'kind':string,'projectId':{'type':['string','null']},'projectRevision':integer,'status':{'enum':['queued','running','completed','failed','review_required','interrupted','cancelled']},'createdAt':integer,'updatedAt':integer,'progress':{'type':'object'},'segments':{'type':'object'},'snapshot':{'type':'object'},'artifacts':array(string),'error':string,'code':string,'result':{'type':'object'}},['id','kind','status']),
'Reference':obj({'id':string,'name':string,'profile':string,'prompt':string,'imageKey':string,'createdAt':integer}),
'Inventory':obj({'revision':string,'nodes':{'type':'object'},'models':array(obj({'name':string,'type':string})),'loras':array(string),'textEncoders':array(string),'vaes':array(string),'assets':array({'type':'object'}),'hashSupport':boolean}),
'Event':obj({'seq':integer,'at':{'type':'string','format':'date-time'},'phase':string,'role':string,'model':string,'segmentId':string,'segmentIndex':integer,'totalSegments':integer,'node':string,'value':integer,'max':integer,'framesChecked':integer,'tokens':integer,'error':string})}
paths={}
def route(path,method,summary,response=None,body=None,status='200',description=''):
    op={'summary':summary,'description':description,'responses':{status:{'description':'Success','content':{'application/json':{'schema':response or {'type':'object'}}}},'401':{'description':'Session required','content':{'application/json':{'schema':S('Error')}}},'409':{'description':'Revision conflict or job busy','content':{'application/json':{'schema':S('Error')}}},'422':{'description':'Validation or execution prerequisite failed','content':{'application/json':{'schema':S('Error')}}}}}
    params=[]
    for part in path.split('/'):
        if part.startswith('{'):params.append({'name':part[1:-1],'in':'path','required':True,'schema':string})
    if params:op['parameters']=params
    if body:op['requestBody']={'required':True,'content':{'application/json':{'schema':body}}}
    paths.setdefault(path,{})[method]=op
route('/api/session','post','접속 코드로 브라우저 세션 생성',body=obj({'code':string},['code']))
paths['/api/session']['post']['security']=[]
route('/api/bootstrap','get','프로젝트·레퍼런스·설정·실행 기록',obj({'settings':S('Settings'),'projects':array(S('Project')),'references':array(S('Reference')),'jobs':array(S('Job')),'roles':array(string)}))
route('/api/settings','put','전역 설정 저장',S('Settings'),S('Settings'),description='revision 일치 필요. 누락된 기존 token은 유지하고 응답에는 반환하지 않는다. 역할/강화/ComfyUI 선택은 전역에만 존재한다.')
route('/api/connections/{id}/models','post','실제 모델·LoRA 목록 조회',{'oneOf':[S('Inventory'),obj({'models':array(obj({'id':string,'name':string})),'settings':S('Settings')})]})
route('/api/projects','post','프로젝트 생성',S('Project'),obj({'title':string},['title']),'201')
route('/api/projects/{id}','patch','시놉시스·선택 프로파일·재생 시간 저장',S('Project'),obj({k:schemas['Project']['properties'][k] for k in ['revision','title','synopsis','modelProfile','duration','mode','referenceId']},['revision']))
route('/api/projects/{id}/approve','post','최신 이야기·타임라인 확정',S('Project'),obj({'revision':integer},['revision']))
route('/api/jobs','post','작업 실행',S('Job'),S('JobRequest'),'202',description='plan/revise/video는 projectId 필수. 같은 프로젝트의 동시 작업은 차단. revise는 constraints를 받아 전체 story/plot/timeline을 재생성. enhance는 target과 prompt 또는 profile 필요. image는 prompt 필수. profile/reference는 선택. video는 승인된 최신 plan 필요. recommend는 전역 선택 LoRA의 출처·강도를 확인.')
paths['/api/jobs']['post']['parameters']=[{'name':'Idempotency-Key','in':'header','schema':string,'description':'같은 제출을 재시도할 때 같은 키 사용. 다른 본문에 재사용 시 409.'}]
route('/api/jobs/{id}','get','작업 상태·결과 조회',S('Job'))
route('/api/jobs/{id}/retry','post','저장된 실행 재개 또는 실패 구간 재생성',S('Job'),description='프로젝트·서버 자산 버전이 일치해야 한다. 완료 구간은 보존. QC 실패 구간만 새 seed로 재생성.')
route('/api/jobs/{id}/cancel','post','다음 단계 중단 및 원격 작업 취소 요청',S('Job'),description='ComfyUI 개별 취소 API 미지원/통신 실패는 remote_cancel_unconfirmed 이벤트로 기록.')
route('/api/jobs/{id}/events','get','작업 이벤트 SSE 재생·실시간 수신')
paths['/api/jobs/{id}/events']['get']['parameters'] += [{'name':'Last-Event-ID','in':'header','schema':integer},{'name':'after','in':'query','schema':integer}]
paths['/api/jobs/{id}/events']['get']['responses']['200']={'description':'SSE: id = seq; data = Event JSON. 15초 heartbeat. 백분율은 실제 노드 step에만 적용.','content':{'text/event-stream':{'schema':string}}}
for provider in ['codex','xai']:route('/api/auth/'+provider,'post',provider+' 구독 device 로그인 시작')
route('/api/auth/codex','get','OpenAI 구독 인증 상태')
route('/api/auth/codex/{id}','get','OpenAI 로그인 요청별 승인 상태')
route('/api/auth/xai/{id}','get','xAI 로그인 진행 상태')
route('/media/{filename}','get','보호된 이미지·영상 파일')
paths['/media/{filename}']['get']['parameters'] += [{'name':'Range','in':'header','schema':string}]
paths['/media/{filename}']['get']['responses']={'200':{'description':'전체 미디어'},'206':{'description':'byte range'},'401':{'description':'접속 코드 필요'},'416':{'description':'잘못된 범위'}}
doc={'openapi':'3.1.0','info':{'title':'Framepop 실행 API','version':'1.0.0','description':'실제 Node 서버 계약. 기존 목업 명세와 분리. 인증 토큰·OAuth 자격 증명·프레임 얼굴 임베딩은 외부 서비스로 자동 전송하지 않는다.'},'servers':[{'url':'/'}],'security':[{'session':[]},{'bearer':[]}],'paths':paths,'components':{'securitySchemes':{'session':{'type':'apiKey','in':'cookie','name':'framepop'},'bearer':{'type':'http','scheme':'bearer'}},'schemas':schemas}}
Path('dist/openapi.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
