import sys,json,os
from pathlib import Path
import cv2,numpy as np
config=json.load(sys.stdin)
root=Path(config['models'])
det=cv2.FaceDetectorYN.create(str(root/'face_detection_yunet_2023mar.onnx'),'',(640,640),0.85)
rec=cv2.FaceRecognizerSF.create(str(root/'face_recognition_sface_2021dec.onnx'),'')
anchors=[np.asarray(a,dtype=np.float32).reshape(1,-1) for a in config.get('anchors',[])]
if not anchors and config.get('referenceImage'):
    image=cv2.imread(config['referenceImage'])
    if image is None:raise RuntimeError('Reference image could not be decoded')
    h,w=image.shape[:2];scale=min(1,640/max(h,w));image=cv2.resize(image,(round(w*scale),round(h*scale)))
    det.setInputSize((image.shape[1],image.shape[0]));_,refs=det.detect(image)
    if refs is None:raise RuntimeError('No verifiable face in reference image')
    for face in refs:
        aligned=rec.alignCrop(image,face)
        if cv2.Laplacian(cv2.cvtColor(aligned,cv2.COLOR_BGR2GRAY),cv2.CV_64F).var()<config['minSharpness']:raise RuntimeError('Reference face is too blurred for identity verification')
        feature=rec.feature(aligned);feature/=max(np.linalg.norm(feature),1e-9);anchors.append(feature.copy())
new_anchors=[];previous=[np.asarray(a,dtype=np.float32).reshape(1,-1) for a in config.get('previousFaces',[])]
cap=cv2.VideoCapture(config['video'])
if not cap.isOpened():raise RuntimeError('Video could not be decoded')
frames=0;bad=0;missing=0;visible=0;first=[];last=[];issues=[]
while True:
    ok,frame=cap.read()
    if not ok:break
    frames+=1
    if frames%24==0:print(json.dumps({'framesChecked':frames}),file=sys.stderr,flush=True)
    height,width=frame.shape[:2];scale=min(1,640/max(height,width));frame=cv2.resize(frame,(round(width*scale),round(height*scale)))
    det.setInputSize((frame.shape[1],frame.shape[0]));_,faces=det.detect(frame)
    if faces is None:
        missing+=1
        continue
    visible+=1;features=[];frame_bad=False
    for face in faces:
        aligned=rec.alignCrop(frame,face);sharpness=float(cv2.Laplacian(cv2.cvtColor(aligned,cv2.COLOR_BGR2GRAY),cv2.CV_64F).var())
        feature=rec.feature(aligned);feature/=max(np.linalg.norm(feature),1e-9);features.append(feature)
        if sharpness<config['minSharpness']:frame_bad=True
        pool=anchors or new_anchors
        if pool:
            match=max(float(np.dot(feature.reshape(-1),a.reshape(-1))) for a in pool)
            if match<config['minSimilarity']:frame_bad=True
    if not anchors and not new_anchors and not frame_bad:new_anchors=[f.copy() for f in features]
    if not first:first=features
    last=features
    if frame_bad:
        bad+=1
        if len(issues)<50:issues.append({'frame':frames,'reason':'face_quality_or_identity'})
cap.release()
if not frames:raise RuntimeError('No decoded frames')
boundary=True
if previous and first and config.get('continuous',False):
    boundary=all(max(float(np.dot(f.reshape(-1),p.reshape(-1))) for p in previous)>=config['minSimilarity'] for f in first)
expect=config.get('expectsFaces',True)
if expect and (not visible or missing/frames>0.35):status='unverifiable'
elif bad/max(1,visible)>config['maxBadFraction'] or not boundary:status='fail'
else:status='pass'
if not expect and not visible:status='no_face'
print(json.dumps({'status':status,'framesChecked':frames,'visibleFrames':visible,'missingFrames':missing,'badFrames':bad,'boundaryPassed':boundary,'issues':issues,'anchors':[a.reshape(-1).tolist() for a in (anchors or new_anchors)],'lastFaces':[a.reshape(-1).tolist() for a in last]}))
