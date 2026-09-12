from pathlib import Path
import subprocess,hashlib,json
root=Path(__file__).resolve().parents[1]/'data'/'qc-models';root.mkdir(parents=True,exist_ok=True)
expected=json.loads((Path(__file__).parent/'qc-models.sha256.json').read_text())
models={'face_detection_yunet_2023mar.onnx':'face_detection_yunet','face_recognition_sface_2021dec.onnx':'face_recognition_sface'}
for name,folder in models.items():
    target=root/name
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==expected[name]: continue
    url=f'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/{folder}/{name}'
    subprocess.run(['curl','--fail','--location','--retry','2',url,'--output',str(target)],check=True)
    if hashlib.sha256(target.read_bytes()).hexdigest()!=expected[name]:
        target.unlink(missing_ok=True)
        raise RuntimeError('QC model checksum mismatch')
    print(f'Installed {name}')
