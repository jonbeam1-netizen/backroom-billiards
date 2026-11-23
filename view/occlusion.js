// Soft shadows and contact darkening for the balls and the cue, worked out in the shader instead of with
// shadow maps. Each ball is a sphere and the cue a tapered rod; each lamp is a small round light, so a shadow is
// sharp where a ball touches the cloth and softens further out, like under a real lamp. Cheap, crisp at any
// picture quality, and no shadow acne or gaps.
import * as THREE from '../lib/three.module.min.js';

const GLSL_PARS = /* glsl */`
uniform vec4 occBalls[ 16 ];   // centre (world) and radius; radius 0 = not on show
uniform vec3 occCueA;          // the cue's tip end
uniform vec3 occCueB;          // and its butt end
uniform vec2 occCueR;          // radius at the tip and at the butt; 0 = no cue
uniform float occLampR;        // the lamp's light-giving radius
uniform mat4 occInvView;
uniform int occSelf;           // the ball this surface belongs to, or -1
varying vec3 occWorld;

float occSphere( vec3 P, vec3 L, float dL, vec3 l, vec4 s ) {
  vec3 toC = s.xyz - P;
  float along = dot( toC, l );
  if ( along <= 0.0 || along > dL ) return 1.0;
  float a = occLampR / dL;                        // the lamp's angular radius
  float perp2 = dot( toC, toC ) - along * along;
  float reach = s.w + a * along * 1.2;
  if ( perp2 > reach * reach ) return 1.0;
  float dC = length( toC );
  float b = asin( min( 1.0, s.w / dC ) );         // the ball's angular radius
  float th = acos( clamp( along / dC, -1.0, 1.0 ) );
  float occMax = min( 1.0, ( b * b ) / ( a * a ) );
  return 1.0 - occMax * ( 1.0 - smoothstep( abs( a - b ), a + b, th ) );
}

float occRod( vec3 P, vec3 L, float dL ) {
  if ( occCueR.x <= 0.0 ) return 1.0;
  vec3 d1 = L - P, d2 = occCueB - occCueA, r = P - occCueA;
  float a = dot( d1, d1 ), e = dot( d2, d2 ), f = dot( d2, r ), c = dot( d1, r ), b = dot( d1, d2 );
  float den = a * e - b * b;
  float s = den > 1e-9 ? clamp( ( b * f - c * e ) / den, 0.0, 1.0 ) : 0.0;
  float t = clamp( ( b * s + f ) / e, 0.0, 1.0 );
  s = clamp( ( b * t - c ) / a, 0.0, 1.0 );
  float dist = length( P + d1 * s - occCueA - d2 * t );
  float rad = mix( occCueR.x, occCueR.y, t );
  float w = max( occLampR * s, 1e-4 );            // half the soft edge's width at that distance
  float occMax = min( 1.0, rad / w );
  return 1.0 - occMax * ( 1.0 - smoothstep( abs( rad - w ), rad + w, dist ) );
}

// how much of one lamp reaches this point past the balls and the cue
float occLight( vec3 Lv ) {
  vec3 L = ( occInvView * vec4( Lv, 1.0 ) ).xyz;
  vec3 P = occWorld;
  vec3 toL = L - P; float dL = length( toL ); vec3 l = toL / dL;
  float v = 1.0;
  #ifdef OCC_BALLS
  for ( int k = 0; k < 16; k ++ ) {
    if ( k == occSelf || occBalls[ k ].w <= 0.0 ) continue;
    v *= occSphere( P, L, dL, l, occBalls[ k ] );
  }
  #endif
  #ifdef OCC_CUE
  v *= occRod( P, L, dL );
  #endif
  #ifdef OCC_BELOW
  v *= clamp( 1.0 + occWorld.y / 0.05, 0.0, 1.0 );
  #endif
  return v;
}

// how much of the soft light from all round reaches this point past the nearby balls
float occAmbient( vec3 N ) {
  float ao = 1.0;
  #ifdef OCC_BALLS
  for ( int k = 0; k < 16; k ++ ) {
    vec4 s = occBalls[ k ];
    if ( k == occSelf || s.w <= 0.0 ) continue;
    vec3 toC = s.xyz - occWorld; float d2 = dot( toC, toC );
    if ( d2 > 0.03 ) continue;
    float d = sqrt( d2 );
    ao *= 1.0 - clamp( dot( N, toC / d ), 0.0, 1.0 ) * min( 1.0, s.w * s.w / d2 );
  }
  #endif
  #ifdef OCC_FLOOR
  // the underside of a ball resting on the cloth sees the cloth it shades itself
  ao *= 1.0 - 0.5 * max( 0.0, -N.y ) * exp( - max( occWorld.y, 0.0 ) / 0.01 );
  #endif
  #ifdef OCC_BELOW
  ao *= clamp( 1.0 + occWorld.y / 0.07, 0.02, 1.0 );
  #endif
  return ao;
}
`;

/**
 * @returns {{uniforms: Object, patch: (m: THREE.Material, o: Object) => void, setBall: Function, setCue: Function}}
 */
export function createOcclusion() {
  const uniforms = {
    occBalls: { value: new Float32Array(64) },
    occCueA: { value: new THREE.Vector3() },
    occCueB: { value: new THREE.Vector3() },
    occCueR: { value: new THREE.Vector2() },
    occLampR: { value: 0.09 },
    occInvView: { value: new THREE.Matrix4() },
  };

  /**
   * Teach a lit material the shadows.
   * @param {THREE.Material} material
   * @param {{balls?:boolean, cue?:boolean, ambient?:boolean, floor?:boolean, below?:boolean, self?:number}} o
   */
  function patch(material, o) {
    const self = { value: o.self === undefined ? -1 : o.self };
    const key = 'occ' + (o.balls ? 'B' : '') + (o.cue ? 'C' : '') + (o.ambient ? 'A' : '') + (o.floor ? 'F' : '') + (o.below ? 'D' : '');
    material.defines = Object.assign(material.defines || {}, {});
    if (o.balls) material.defines.OCC_BALLS = '';
    if (o.cue) material.defines.OCC_CUE = '';
    if (o.floor) material.defines.OCC_FLOOR = '';
    if (o.below) material.defines.OCC_BELOW = '';
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.uniforms.occSelf = self;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 occWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\noccWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      let fs = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GLSL_PARS)
        .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
          'getSpotLightInfo( spotLight, geometryPosition, directLight );',
          'getSpotLightInfo( spotLight, geometryPosition, directLight );\n\t\tdirectLight.color *= occLight( spotLight.position );'));
      if (o.ambient) {
        fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>
  {
    float occA = occAmbient( normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz ) );
    reflectedLight.indirectDiffuse *= occA;
    reflectedLight.indirectSpecular *= mix( 1.0, occA, 0.6 );
  }`);
      }
      shader.fragmentShader = fs;
    };
    material.customProgramCacheKey = () => key;
    material.needsUpdate = true;
    return material;
  }

  const B = uniforms.occBalls.value;
  return {
    uniforms, patch,
    /** Put ball i at (x, y, z), or hide it with r = 0. */
    setBall(i, x, y, z, r) { B[i * 4] = x; B[i * 4 + 1] = y; B[i * 4 + 2] = z; B[i * 4 + 3] = r; },
    /** The cue as a rod from tip (a) to butt (b), or none with ra = 0. */
    setCue(ax, ay, az, bx, by, bz, ra, rb) { uniforms.occCueA.value.set(ax, ay, az); uniforms.occCueB.value.set(bx, by, bz); uniforms.occCueR.value.set(ra, rb); },
  };
}
