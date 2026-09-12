"""Read-only model identity endpoint for exact-version recommendation lookup.
Install this directory under ComfyUI/custom_nodes; no workflows are supplied by users.
"""
import hashlib, json, os, struct
from aiohttp import web
from server import PromptServer
import folder_paths
_CACHE = {}
@PromptServer.instance.routes.get('/framepop/assets')
async def assets(request):
    import asyncio
    def scan():
        result=[]
        for kind in ('loras','diffusion_models','checkpoints'):
            for name in folder_paths.get_filename_list(kind):
                path=folder_paths.get_full_path(kind,name)
                if not path: continue
                st=os.stat(path); key=(path,st.st_mtime_ns,st.st_size)
                if key not in _CACHE:
                    h=hashlib.sha256()
                    with open(path,'rb') as f:
                        for block in iter(lambda:f.read(8*1024*1024),b''): h.update(block)
                    metadata={}
                    if path.endswith('.safetensors'):
                        try:
                            with open(path,'rb') as f:
                                n=struct.unpack('<Q',f.read(8))[0]
                                if n<16*1024*1024: metadata=json.loads(f.read(n)).get('__metadata__',{})
                        except (ValueError, OSError): pass
                    _CACHE[key]={'sha256':h.hexdigest(),'metadata':metadata}
                result.append({'name':name,'type':kind,**_CACHE[key]})
        return {'assets':result}
    return web.json_response(await asyncio.to_thread(scan))
NODE_CLASS_MAPPINGS={}
NODE_DISPLAY_NAME_MAPPINGS={}
