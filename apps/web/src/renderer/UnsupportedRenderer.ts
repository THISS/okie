import type { AtlasRenderer, AtlasScene, Camera, PickResult, RenderState, RendererDiagnostics } from './types';

export class UnsupportedRenderer implements AtlasRenderer {
  readonly kind = 'unsupported';
  private scene?: AtlasScene;

  constructor(private readonly requestedBackend: string, private readonly reason: string) {}

  setScene(scene: AtlasScene) { this.scene = scene; }
  setCamera(_camera: Camera) {}
  setRenderState(_state: RenderState) {}
  resize(_width: number, _height: number, _devicePixelRatio: number) {}
  render(_timeMs: number) {}
  pick(_screenX: number, _screenY: number): PickResult | undefined { return undefined; }
  visibleScene() { return { objectIds: [], relationIds: [] }; }
  lodState() { return undefined; }
  diagnostics(): RendererDiagnostics {
    return {
      requestedBackend: this.requestedBackend,
      activeBackend: this.kind,
      gpuAccelerated: false,
      entityCount: this.scene?.entities.length ?? 0,
      relationCount: this.scene?.relations.length ?? 0,
      lastFrameMs: 0,
      message: this.reason,
      visibleEntities: 0,
      visibleRelations: 0,
      candidateEntities: 0,
      candidateRelations: 0,
      culledEntities: this.scene?.entities.length ?? 0,
      culledRelations: this.scene?.relations.length ?? 0,
      drawCalls: 0,
      meshRebuilt: false,
      meshBuildMs: 0,
      geometryUploadBytes: 0,
      geometryBufferUploads: 0,
      glyphQuads: 0,
      deferredTextPrimitives: 0,
      deferredIconPrimitives: 0,
    };
  }
  dispose() { this.scene = undefined; }
}
