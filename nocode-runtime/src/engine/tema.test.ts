import { describe, it, expect } from 'vitest';
import {
  normalizarCor, hashToken, construirMapaTokens, corToken,
  raioToken, sombraToken, fonteToken, chaveDeCor,
} from './tema';

describe('normalizarCor', () => {
  it('canonicaliza as quatro grafias da mesma cor', () => {
    const alvo = 'rgba(0,191,99,1)';
    expect(normalizarCor('#00BF63')).toBe(alvo);
    expect(normalizarCor('#00bf63')).toBe(alvo);
    expect(normalizarCor('rgb(0, 191, 99)')).toBe(alvo);
    expect(normalizarCor('rgba(0, 191, 99, 1)')).toBe(alvo);
  });

  it('expande hex de 3 dígitos', () => {
    expect(normalizarCor('#fff')).toBe('rgba(255,255,255,1)');
  });

  it('preserva alfa fracionário sem zero à direita', () => {
    expect(normalizarCor('rgba(128,128,128,0.17)')).toBe('rgba(128,128,128,0.17)');
    expect(normalizarCor('rgba(0,0,0,.5)')).toBe('rgba(0,0,0,0.5)');
  });

  it('devolve null para o que não é cor', () => {
    expect(normalizarCor('var(--color_x_default)')).toBeNull();
    expect(normalizarCor('Gerenciar vagas')).toBeNull();
    expect(normalizarCor('')).toBeNull();
  });

  it('normaliza hex de 8 dígitos com alfa a 3 casas decimais', () => {
    expect(normalizarCor('#00BF6380')).toBe('rgba(0,191,99,0.502)');
    expect(normalizarCor('#00BF63FF')).toBe('rgba(0,191,99,1)');
    expect(normalizarCor('#00BF6300')).toBe('rgba(0,191,99,0)');
  });

  it('bytes de alfa adjacentes (127, 128) permanecem distintos', () => {
    const hex127 = normalizarCor('#00BF637F');
    const hex128 = normalizarCor('#00BF6380');
    expect(hex127).not.toBe(hex128);
    expect(hex127).toBe('rgba(0,191,99,0.498)');
    expect(hex128).toBe('rgba(0,191,99,0.502)');
  });

  it('rgba com 3 casas decimais e hex de 8 dígitos normalizam iguais', () => {
    expect(normalizarCor('rgba(0,191,99,0.502)')).toBe(normalizarCor('#00BF6380'));
  });

  it('preserva alfas reais do app intactos', () => {
    // Alfas medidos do export do app-marketplace (≤2 casas decimais)
    expect(normalizarCor('rgba(0,0,0,0.17)')).toBe('rgba(0,0,0,0.17)');
    expect(normalizarCor('rgba(0,0,0,0.2)')).toBe('rgba(0,0,0,0.2)');
    expect(normalizarCor('rgba(0,0,0,0.12)')).toBe('rgba(0,0,0,0.12)');
    expect(normalizarCor('rgba(0,0,0,0.08)')).toBe('rgba(0,0,0,0.08)');
    expect(normalizarCor('rgba(0,0,0,0.49)')).toBe('rgba(0,0,0,0.49)');
    expect(normalizarCor('rgba(0,0,0,0.47)')).toBe('rgba(0,0,0,0.47)');
    expect(normalizarCor('rgba(0,0,0,1)')).toBe('rgba(0,0,0,1)');
    expect(normalizarCor('rgba(0,0,0,0)')).toBe('rgba(0,0,0,0)');
  });

  it('arredonda alfas computadas dinamicamente (alta precisão) para 3 casas', () => {
    // Alfas de expressão dinâmica da plataforma podem ter precisão arbitrária de ponto flutuante
    expect(normalizarCor('rgba(0,0,0,0.12345)')).toBe('rgba(0,0,0,0.123)');
    // Verifica que o rgba path e hex8 path sincronizam para a mesma cor
    expect(normalizarCor('rgba(0,191,99,0.5019607843137255)')).toBe(normalizarCor('#00BF6380'));
  });
});

describe('hashToken', () => {
  it('é determinístico', () => {
    expect(hashToken('rgba(0,191,99,1)')).toBe(hashToken('rgba(0,191,99,1)'));
  });
  it('separa valores diferentes', () => {
    expect(hashToken('rgba(0,191,99,1)')).not.toBe(hashToken('rgba(0,191,99,0.5)'));
  });
  it('produz identificador CSS válido', () => {
    expect(hashToken('rgba(0,0,0,1)')).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe('construirMapaTokens', () => {
  const cs = {
    color_tokens: { text: { default: 'rgba(26, 26, 26, 1)' } },
    color_tokens_user: {
      default: {
        bTHgk: { name: 'Verde Agron', rgba: 'rgba(0,191,99,1)', deleted: false },
        bTdel: { name: 'Morto', rgba: 'rgba(1,2,3,1)', deleted: true },
      },
    },
  };

  it('indexa built-in e user pelo valor normalizado', () => {
    const m = construirMapaTokens(cs);
    expect(m['rgba(26,26,26,1)']).toBe('--color_text_default');
    expect(m['rgba(0,191,99,1)']).toBe('--color_bTHgk_default');
  });

  it('ignora token marcado como deleted', () => {
    expect(construirMapaTokens(cs)['rgba(1,2,3,1)']).toBeUndefined();
  });
});

describe('corToken', () => {
  const mapa = { 'rgba(0,191,99,1)': '--color_bTHgk_default' };

  it('religa ao token existente quando o valor bate', () => {
    expect(corToken('#00BF63', mapa)).toBe('var(--color_bTHgk_default, #00BF63)');
  });

  it('mantém o valor ORIGINAL no fallback, não o normalizado', () => {
    expect(corToken('#00BF63', mapa)).toContain('#00BF63');
    expect(corToken('#00BF63', mapa)).not.toContain('rgba(0,191,99,1)');
  });

  it('gera token novo quando não há correspondência', () => {
    const h = hashToken('rgba(189,189,189,1)');
    expect(corToken('rgba(189,189,189,1)', mapa)).toBe(`var(--c_${h}, rgba(189,189,189,1))`);
  });

  it('não mexe no que já é var()', () => {
    expect(corToken('var(--color_x_default)', mapa)).toBe('var(--color_x_default)');
  });

  it('devolve a entrada intacta quando não é cor', () => {
    expect(corToken('nao-e-cor', mapa)).toBe('nao-e-cor');
  });
});

describe('raioToken / sombraToken / fonteToken', () => {
  it('raio usa o próprio número no nome', () => {
    expect(raioToken(12)).toBe('var(--r_12, 12px)');
    expect(raioToken(0)).toBe('var(--r_0, 0px)');
  });

  it('sombra usa UM token só, com a sombra original no fallback', () => {
    const s = '0px 0px 16px 0px rgba(170,170,170,0.3)';
    // um token para todas: `tema-original` não o define e cada elemento fica com a sua;
    // `tema-cliente` define uma linha e as 39 viram a --shadow-card do DS.
    expect(sombraToken(s)).toBe(`var(--sh_override, ${s})`);
  });

  it('sombras diferentes usam o MESMO token, cada uma com seu fallback', () => {
    expect(sombraToken('a')).toBe('var(--sh_override, a)');
    expect(sombraToken('b')).toBe('var(--sh_override, b)');
  });

  it('fonte vira slug e mantém a família como fallback', () => {
    expect(fonteToken('Open Sans')).toBe("var(--ff_open_sans, 'Open Sans')");
    expect(fonteToken('Poppins')).toBe("var(--ff_poppins, 'Poppins')");
  });
});

describe('chaveDeCor', () => {
  it('aceita as chaves que a medição encontrou', () => {
    for (const k of ['bgcolor', 'font_color', 'icon_color', 'border_color_bottom',
                     'boxshadow_color', 'placeholder_color', 'tag_font_color',
                     'background_gradient_from', 'AAf', 'AAJ', 'color2']) {
      expect(chaveDeCor(k), k).toBe(true);
    }
  });

  it('recusa chaves de conteúdo', () => {
    for (const k of ['text', 'placeholder', 'caption', 'name', 'value']) {
      expect(chaveDeCor(k), k).toBe(false);
    }
  });
});
