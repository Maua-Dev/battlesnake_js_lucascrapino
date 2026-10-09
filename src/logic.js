// Bem-vindo ao
// __________         __    __  .__                               __
// \______   \_____ _/  |__/  |_|  |   ____   ______ ____ _____  |  | __ ____
//  |    |  _/\__  \   __\   __\  | _/ __ \ /  ___//    \__  \ |  |/ // __ \
//  |    |   \ / __ \|  |  |  | |  |_\  ___/ \___ \|   |  \/ __ \|    <\  ___/
//  |________/(______/__|  |__| |____/\_____>______>___|__(______/__|__\_____>
//

const MOVES = ["up", "down", "left", "right"];
const DX = [0, 0, -1, 1];
const DY = [1, -1, 0, 0];

// Pontuações-base. Valores grandes = "praticamente proibido".
const MORTE_CERTA = -1_000_000;
const CABECA_PERDEDORA = -5_000;
const ARMADILHA = -3_000;

// Busca do mano a mano.
const VITORIA = 1_000_000;
const EMPATE = -500_000; // morrer junto ainda é não ganhar

// Tempo de pensamento. O `game.timeout` (500 ms no padrão) inclui a ida e
// volta pela internet, então usamos só uma fração dele.
const FRACAO_DO_TIMEOUT = 0.4;
const TETO_MS = 150;

class SemTempo extends Error {}

// GET / — chamado quando você cadastra a cobra no site e a cada partida.
// Opções de cabeça, cauda e cor: https://docs.battlesnake.com/guides/customizations
export function info() {
  if (process.env.DEBUG === "true") {
    console.log("INFO");
  }

  return {
    apiversion: "1",
    author: "",           // TODO: coloque aqui o SEU usuário do Battlesnake
    color: "#E8A317",
    head: "fang",
    tail: "sharp",
    version: "2.0.0",
  };
}

// POST /start — chamado uma vez, quando a partida começa.
export function start(gameState) {
  console.log(`JOGO COMEÇOU (partida ${gameState.game.id})`);
}

// POST /end — chamado uma vez, quando a partida termina.
export function end(gameState) {
  console.log(`FIM DE JOGO após ${gameState.turn} turnos`);
}

// ---------------------------------------------------------------------------
// Leitura do tabuleiro (casas viram inteiros: y * largura + x)
// ---------------------------------------------------------------------------

function criarTabuleiro(gameState, prazo) {
  const w = gameState.board.width;
  const h = gameState.board.height;
  const n = w * h;
  const dentro = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
  const converter = (body) => (body || []).map((c) => (dentro(c.x, c.y) ? c.y * w + c.x : -1));

  // Vizinhos pré-calculados de cada casa.
  const viz = new Array(n);
  for (let c = 0; c < n; c++) {
    const x = c % w;
    const y = (c / w) | 0;
    const lst = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (dentro(nx, ny)) lst.push(ny * w + nx);
    }
    viz[c] = lst;
  }

  const you = gameState.you;
  let myBody = converter(you.body);
  if (myBody.length === 0 && you.head) myBody = converter([you.head]);

  const food = new Uint8Array(n);
  const foodList = [];
  for (const c of gameState.board.food || []) {
    if (dentro(c.x, c.y)) {
      food[c.y * w + c.x] = 1;
      foodList.push(c.y * w + c.x);
    }
  }
  const hazard = new Uint8Array(n);
  for (const c of gameState.board.hazards || []) {
    if (dentro(c.x, c.y)) hazard[c.y * w + c.x] = 1;
  }

  const settings = (gameState.game && gameState.game.ruleset && gameState.game.ruleset.settings) || {};
  const hazardDamage = Number(settings.hazardDamagePerTurn ?? 14) || 0;

  // Adversários: todas as cobras menos a minha.
  const opps = [];
  for (const s of gameState.board.snakes || []) {
    if (!s || s.id === you.id || !s.body || s.body.length === 0) continue;
    const body = converter(s.body);
    if (body[0] < 0) continue;
    opps.push({ id: s.id, body, head: body[0], len: body.length, health: s.health });
  }

  // occ[casa] = em quantos turnos (a partir de agora) a casa fica livre.
  const occOpps = new Int32Array(n);
  for (const o of opps) marcarCorpo(occOpps, o.body, o.len, 0);

  return {
    w, h, n, viz, prazo,
    myBody,
    myLen: myBody.length,
    health: you.health,
    food, foodList, hazard, hazardDamage,
    opps, occOpps,
    destino(c, d) {
      const x = (c % w) + DX[d];
      const y = ((c / w) | 0) + DY[d];
      return dentro(x, y) ? y * w + x : -1;
    },
    manhattan(a, b) {
      return Math.abs((a % w) - (b % w)) + Math.abs(((a / w) | 0) - ((b / w) | 0));
    },
  };
}

// Segmento i de uma cobra com L partes some depois de L - i movimentos.
// Cauda empilhada (acabou de comer) aparece repetida: vale o menor índice.
function marcarCorpo(occ, body, len, offset) {
  for (let i = 0; i < body.length; i++) {
    const seg = body[i];
    if (seg < 0) continue;
    const livreEm = offset + len - i;
    if (occ[seg] < livreEm) occ[seg] = livreEm;
  }
}

// ---------------------------------------------------------------------------
// Buscas no tabuleiro
// ---------------------------------------------------------------------------

// BFS com noção de tempo: uma casa só pode ser pisada no turno t se occ <= t.
// Devolve { area, dist } (dist = -1 para inalcançável).
function floodFill(tab, origem, occ, t0) {
  const dist = new Int32Array(tab.n).fill(-1);
  const fila = new Int32Array(tab.n);
  let ini = 0;
  let fim = 0;
  dist[origem] = 0;
  fila[fim++] = origem;
  while (ini < fim) {
    const p = fila[ini++];
    const prox = dist[p] + 1;
    for (const q of tab.viz[p]) {
      if (dist[q] !== -1 || occ[q] > t0 + prox) continue;
      dist[q] = prox;
      fila[fim++] = q;
    }
  }
  return { area: fim, dist };
}

// Quantos turnos a cobra aguenta viva a partir de `corpo` (cabeça já na casa
// nova, turno 1), simulando o próprio corpo andando passo a passo. O flood
// fill sozinho é otimista: conta casas que só liberam no futuro, mesmo
// quando não dá para esperar até lá.
function sobrevivencia(tab, corpo, alvo, orcamento) {
  const segs = corpo.filter((c) => c >= 0);
  const len = segs.length;
  const cap = len + alvo + 2;
  const pos = new Int32Array(cap);
  const noCorpo = new Int32Array(tab.n);
  const inicio = alvo + 1;
  for (let i = 0; i < len; i++) {
    pos[inicio + i] = segs[i];
    noCorpo[segs[i]]++;
  }
  let melhor = 0;
  let nos = 0;

  const dfs = (head, turno, prof) => {
    if (prof > melhor) melhor = prof;
    if (melhor >= alvo || nos >= orcamento) return;
    nos++;
    if ((nos & 511) === 0 && performance.now() > tab.prazo) {
      nos = orcamento;
      return;
    }
    const cauda = pos[head + len - 1];
    noCorpo[cauda]--; // a cauda sai do lugar neste passo
    for (const q of tab.viz[pos[head]]) {
      if (tab.occOpps[q] > turno + 1 || noCorpo[q] > 0) continue;
      pos[head - 1] = q;
      noCorpo[q]++;
      dfs(head - 1, turno + 1, prof + 1);
      noCorpo[q]--;
      if (melhor >= alvo || nos >= orcamento) break;
    }
    noCorpo[cauda]++;
  };

  dfs(inicio, 1, 0);
  return melhor;
}

// Voronoi: cada casa fica com a cobra que chega primeiro. `fontes` é uma
// lista de [casa, turno de partida, dono]. Empate fica com a maior; tamanhos
// iguais = ninguém. Devolve { dono, tempo } (dono -1 = ninguém).
function voronoi(tab, fontes, tamanhos, occ) {
  const n = tab.n;
  const dono = new Int32Array(n).fill(-1);
  const tempo = new Int32Array(n).fill(0x3fffffff);
  const pendentes = [...fontes].sort((a, b) => a[1] - b[1]);
  let i = 0;
  let t = pendentes.length ? pendentes[0][1] : 0;
  let fronteira = [];

  while (fronteira.length || i < pendentes.length) {
    const chegadas = new Map();
    const chegar = (q, quem) => {
      let s = chegadas.get(q);
      if (!s) chegadas.set(q, (s = []));
      if (!s.includes(quem)) s.push(quem);
    };
    while (i < pendentes.length && pendentes[i][1] === t) {
      chegar(pendentes[i][0], pendentes[i][2]);
      i++;
    }
    for (const [p, quem] of fronteira) {
      for (const q of tab.viz[p]) {
        if (tempo[q] < t || occ[q] > t) continue;
        chegar(q, quem);
      }
    }
    fronteira = [];
    for (const [q, quems] of chegadas) {
      if (tempo[q] < t) continue;
      tempo[q] = t;
      let quem = quems[0];
      if (quems.length > 1) {
        quems.sort((a, b) => tamanhos[b] - tamanhos[a]);
        quem = tamanhos[quems[0]] > tamanhos[quems[1]] ? quems[0] : -1;
      }
      dono[q] = quem;
      if (quem !== -1) fronteira.push([q, quem]);
    }
    t++;
    if (t > n + 2) break;
  }
  return { dono, tempo };
}

// ---------------------------------------------------------------------------
// Heurística de uma jogada (usada sempre; decide sozinha com 3+ cobras)
// ---------------------------------------------------------------------------

function avaliar(tab, d) {
  const head = tab.myBody[0];
  const nova = tab.destino(head, d);

  // 1. Morte certa: parede, corpo (a cauda que vai sair é liberada), fome.
  if (nova < 0) return MORTE_CERTA;
  const occAgora = Int32Array.from(tab.occOpps);
  marcarCorpo(occAgora, tab.myBody, tab.myLen, 0);
  if (occAgora[nova] > 1) return MORTE_CERTA;

  const comeu = tab.food[nova] === 1;
  let vida = comeu ? 100 : tab.health - 1;
  if (tab.hazard[nova] && !comeu) vida -= tab.hazardDamage;
  if (vida <= 0) return MORTE_CERTA;

  const novoCorpo = [nova, ...(comeu ? tab.myBody : tab.myBody.slice(0, -1))];
  const meuLen = novoCorpo.length;
  let score = 0;

  // 2. Cabeça com cabeça: maior ou igual mata; menor é presa.
  for (const o of tab.opps) {
    if (tab.manhattan(o.head, nova) === 1) {
      score += o.len >= tab.myLen ? CABECA_PERDEDORA : 250;
    }
  }

  // 3. Espaço: nada de beco sem saída.
  const occ = Int32Array.from(tab.occOpps);
  marcarCorpo(occ, novoCorpo, meuLen, 1);
  occ[nova] = 0;
  const { area, dist } = floodFill(tab, nova, occ, 1);
  const alvo = Math.min(meuLen + 2, 30);
  const folego = sobrevivencia(tab, novoCorpo, alvo, 20_000);
  if (folego < alvo) {
    score += ARMADILHA + folego * 80;
  } else if (area < meuLen) {
    score += -400 + area * 10;
  } else {
    score += Math.min(area, meuLen * 3);
  }

  // 4. Território: eu parto da casa nova (turno 1), os rivais das cabeças (turno 0).
  const fontes = [[nova, 1, 0]];
  const tamanhos = [tab.myLen];
  const occV = Int32Array.from(occ);
  tab.opps.forEach((o, k) => {
    fontes.push([o.head, 0, k + 1]);
    tamanhos.push(o.len);
    occV[o.head] = 0;
  });
  const { dono } = voronoi(tab, fontes, tamanhos, occV);
  const terr = new Array(tab.opps.length + 1).fill(0);
  for (let c = 0; c < tab.n; c++) if (dono[c] >= 0) terr[dono[c]]++;

  // Fome dinâmica: considera quão longe está a comida alcançável mais próxima.
  let maisPerto = Infinity;
  for (const f of tab.foodList) if (dist[f] >= 0) maisPerto = Math.min(maisPerto, dist[f]);
  const fome = tab.health < 35 || (maisPerto !== Infinity && tab.health <= maisPerto + 15);
  if (maisPerto !== Infinity && tab.health <= maisPerto + 6) {
    score -= 60 * maisPerto; // fome crítica: comida antes de tudo
  }

  score += (fome ? 0.5 : 1.5) * terr[0];
  if (terr[0] < meuLen) {
    // Espaço que eu alcanço antes de todo mundo não cabe meu corpo: corredor
    // que uma rival pode fechar. O flood fill sozinho não enxerga isso.
    score -= 800 - 20 * terr[0];
  }

  // 5. Caça: escolhe a presa (a menor que eu mais próxima) e vai para cima.
  let presa = -1;
  let distPresa = Infinity;
  tab.opps.forEach((o, k) => {
    if (o.len < tab.myLen) {
      const dd = tab.manhattan(o.head, head);
      if (dd < distPresa) {
        distPresa = dd;
        presa = k;
      }
    }
  });

  tab.opps.forEach((o, k) => {
    const dd = tab.manhattan(o.head, nova);
    const terrDele = terr[k + 1];
    if (k === presa && !fome) {
      // Aproxima da cabeça e rouba o espaço dela.
      score -= 10 * dd;
      score -= 2.5 * terrDele;
      if (terrDele < o.len) score += 500; // presa encurralada
    } else if (o.len < tab.myLen) {
      score -= 0.5 * terrDele;
      if (terrDele < o.len) score += 200;
    } else if (dd <= 4) {
      // Maior ou igual: distância segura.
      score -= (5 - dd) * 55;
    }
  });

  // 6. Comida: engorda até ficar bem maior que todas.
  const maiorRival = tab.opps.reduce((m, o) => Math.max(m, o.len), 0);
  let vontade;
  if (fome) vontade = 2.5;
  else if (tab.myLen <= maiorRival + 1) vontade = 2.0; // precisa de tamanho pra caçar
  else if (presa >= 0) vontade = 0.4; // já tem presa: foco na caça
  else vontade = 1.0;

  let melhor = 0;
  for (const f of tab.foodList) {
    const df = dist[f];
    if (df < 0) continue;
    const minha = dono[f] === 0 || f === nova;
    const seguro = minha || dono[f] === -1 || fome ? 1 : 0.2;
    let valor = (80 * seguro) / (df + 1);
    if (fome) valor = Math.max(valor, (300 - 10 * df) * seguro);
    melhor = Math.max(melhor, valor);
  }
  score += vontade * melhor;

  // 7. Hazard tira vida: evita quando der.
  if (tab.hazard[nova] && !comeu) score -= 40 + (100 - tab.health);

  return score;
}

// ---------------------------------------------------------------------------
// Mano a mano: minimax com alpha-beta
// ---------------------------------------------------------------------------

// Aplica as jogadas simultâneas seguindo a ordem oficial de resolução.
// a e b são { corpo, vida }; `turno` é quantos turnos à frente este lance
// acontece (as outras cobras, se houver, são obstáculos que vão liberando).
function simular(tab, a, b, food, da, db, turno) {
  const ha = tab.destino(a.corpo[0], da);
  const hb = tab.destino(b.corpo[0], db);
  let vivoA = ha >= 0;
  let vivoB = hb >= 0;

  const comeuA = vivoA && food[ha] === 1;
  const comeuB = vivoB && food[hb] === 1;
  let vidaA = a.vida - 1;
  let vidaB = b.vida - 1;
  if (vivoA && tab.hazard[ha] && !comeuA) vidaA -= tab.hazardDamage;
  if (vivoB && tab.hazard[hb] && !comeuB) vidaB -= tab.hazardDamage;
  if (comeuA) vidaA = 100;
  if (comeuB) vidaB = 100;

  const mover = (corpo, nova, comeu) => {
    const r = [nova, ...corpo.slice(0, -1)];
    if (comeu) r.push(r[r.length - 1]); // cauda empilhada: cresce no próximo turno
    return r;
  };
  const ca = vivoA ? mover(a.corpo, ha, comeuA) : a.corpo;
  const cb = vivoB ? mover(b.corpo, hb, comeuB) : b.corpo;

  let novaFood = food;
  if (comeuA || comeuB) {
    novaFood = Uint8Array.from(food);
    if (comeuA) novaFood[ha] = 0;
    if (comeuB) novaFood[hb] = 0;
  }

  const bate = (corpo, c) => corpo.indexOf(c, 1) !== -1;
  const outros = tab.occOutros;
  let mortoA = !vivoA || vidaA <= 0 || bate(ca, ha) || (vivoB && bate(cb, ha)) || (outros && outros[ha] > turno);
  let mortoB = !vivoB || vidaB <= 0 || bate(cb, hb) || (vivoA && bate(ca, hb)) || (outros && outros[hb] > turno);
  if (vivoA && vivoB && ha === hb) {
    if (ca.length > cb.length) mortoB = true;
    else if (cb.length > ca.length) mortoA = true;
    else mortoA = mortoB = true;
  }
  return {
    a: { corpo: ca, vida: vidaA },
    b: { corpo: cb, vida: vidaB },
    food: novaFood,
    vivoA: !mortoA,
    vivoB: !mortoB,
  };
}

// Direções que não batem na parede nem no pescoço.
function jogadasPlausiveis(tab, corpo) {
  const pescoco = corpo.length > 1 ? corpo[1] : -1;
  const res = [];
  for (let d = 0; d < 4; d++) {
    const q = tab.destino(corpo[0], d);
    if (q >= 0 && q !== pescoco) res.push(d);
  }
  return res.length ? res : [0];
}

// Avaliação de uma posição do mano a mano, do meu ponto de vista.
function avaliarFolha(tab, a, b, food, turno) {
  const la = a.corpo.length;
  const lb = b.corpo.length;
  const occ = new Int32Array(tab.n);
  if (tab.occOutros) {
    for (let c = 0; c < tab.n; c++) occ[c] = Math.max(0, tab.occOutros[c] - turno);
  }
  marcarCorpo(occ, a.corpo, la, 0);
  marcarCorpo(occ, b.corpo, lb, 0);
  occ[a.corpo[0]] = 0;
  occ[b.corpo[0]] = 0;
  const { dono, tempo } = voronoi(tab, [[a.corpo[0], 0, 0], [b.corpo[0], 0, 1]], [la, lb], occ);

  let meu = 0;
  let dele = 0;
  let comidaMinha = Infinity;
  let comidaQualquer = Infinity;
  for (let c = 0; c < tab.n; c++) {
    if (dono[c] === 0) {
      meu++;
      if (food[c] && tempo[c] < comidaMinha) comidaMinha = tempo[c];
    } else if (dono[c] === 1) {
      dele++;
    }
    if (food[c] && tempo[c] < 0x3fffffff && tempo[c] < comidaQualquer) {
      comidaQualquer = tempo[c];
    }
  }

  let score = 4 * (meu - dele) + 30 * (la - lb);
  if (meu < la) score -= 3000 - 40 * meu;
  if (dele < lb) score += 3000 - 40 * dele; // encurralado

  const pesoComida = la <= lb + 1 || a.vida < 40 ? 70 : 15;
  if (comidaMinha !== Infinity) score += pesoComida / (comidaMinha + 1);
  const alvoComida = comidaMinha !== Infinity ? comidaMinha : comidaQualquer;
  if (alvoComida !== Infinity) {
    const folga = a.vida - alvoComida;
    if (folga <= 0) score -= 2000; // não chega na comida a tempo
    else if (folga < 20) score -= (20 - folga) * 40; // fome apertando
  } else if (a.vida < 30) {
    score -= (30 - a.vida) * 30;
  }

  // Estilo caçadora: maior por 1 ou mais já pressiona a cabeça dele.
  if (la > lb) score -= 10 * tab.manhattan(a.corpo[0], b.corpo[0]);
  return score;
}

function minimax(tab, a, b, food, prof, alpha, beta, ply) {
  if (performance.now() > tab.prazo) throw new SemTempo();
  let melhor = -Infinity;
  const dele = jogadasPlausiveis(tab, b.corpo);
  for (const da of jogadasPlausiveis(tab, a.corpo)) {
    let pior = Infinity;
    for (const db of dele) {
      const r = simular(tab, a, b, food, da, db, ply + 1);
      let v;
      if (!r.vivoA && !r.vivoB) v = EMPATE + ply;
      else if (!r.vivoA) v = -VITORIA + ply;
      else if (!r.vivoB) v = VITORIA - ply;
      else if (prof <= 1) v = avaliarFolha(tab, r.a, r.b, r.food, ply + 1);
      else v = minimax(tab, r.a, r.b, r.food, prof - 1, Math.max(alpha, melhor), Math.min(beta, pior), ply + 1);
      if (v < pior) pior = v;
      if (pior <= Math.max(alpha, melhor)) break;
    }
    if (pior > melhor) melhor = pior;
    if (melhor >= beta) break;
  }
  return melhor;
}

// Aprofundamento iterativo até acabar o tempo. Devolve a nota de cada direção.
// `k` é o rival da busca; as demais cobras viram obstáculos.
function buscaManoAMano(tab, notasBase, k) {
  const o = tab.opps[k];
  tab.occOutros = null;
  if (tab.opps.length > 1) {
    tab.occOutros = new Int32Array(tab.n);
    tab.opps.forEach((x, i) => {
      if (i !== k) marcarCorpo(tab.occOutros, x.body, x.len, 0);
    });
  }
  if (tab.myBody.some((c) => c < 0)) return null;
  const a = { corpo: tab.myBody, vida: tab.health };
  const b = { corpo: o.body, vida: o.health };
  const candidatas = [0, 1, 2, 3].filter((d) => notasBase[d] > MORTE_CERTA);
  if (candidatas.length <= 1) return null;

  let resultado = null;
  for (let prof = 1; prof <= 20; prof++) {
    const ref = resultado || notasBase;
    candidatas.sort((x, y) => ref[y] - ref[x]); // melhor da rodada anterior primeiro
    const atual = [MORTE_CERTA, MORTE_CERTA, MORTE_CERTA, MORTE_CERTA];
    try {
      for (const da of candidatas) {
        let pior = Infinity;
        for (const db of jogadasPlausiveis(tab, b.corpo)) {
          const r = simular(tab, a, b, tab.food, da, db, 1);
          let v;
          if (!r.vivoA && !r.vivoB) v = EMPATE;
          else if (!r.vivoA) v = -VITORIA;
          else if (!r.vivoB) v = VITORIA;
          else if (prof <= 1) v = avaliarFolha(tab, r.a, r.b, r.food, 1);
          else v = minimax(tab, r.a, r.b, r.food, prof - 1, -Infinity, pior, 1);
          pior = Math.min(pior, v);
        }
        atual[da] = pior;
      }
    } catch (e) {
      if (e instanceof SemTempo) break;
      throw e;
    }
    resultado = atual;
    if (Math.max(...resultado) >= VITORIA - 100) break; // vitória garantida
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// POST /move — chamado a cada turno. Devolve "up", "down", "left" ou "right".
// Exemplo do JSON recebido: https://docs.battlesnake.com/api/example-move
// ---------------------------------------------------------------------------

export function move(gameState) {
  const inicio = performance.now();
  const timeoutMs = (gameState.game && gameState.game.timeout) || 500;
  const tab = criarTabuleiro(gameState, inicio + Math.min(TETO_MS, timeoutMs * FRACAO_DO_TIMEOUT));

  if (tab.myBody.length === 0 || tab.myBody[0] < 0) {
    return { move: "up" };
  }

  const notas = [0, 1, 2, 3].map((d) => avaliar(tab, d));
  let escolhido = 0;
  for (let d = 1; d < 4; d++) if (notas[d] > notas[escolhido]) escolhido = d;

  if (tab.opps.length === 1) {
    // Mano a mano: a busca decide e a heurística desempata.
    const busca = buscaManoAMano(tab, notas, 0);
    if (busca) {
      escolhido = 0;
      for (let d = 1; d < 4; d++) {
        if (busca[d] > busca[escolhido] || (busca[d] === busca[escolhido] && notas[d] > notas[escolhido])) {
          escolhido = d;
        }
      }
    }
  } else if (tab.opps.length > 1) {
    // Várias cobras: busca contra a rival mais próxima só como checagem
    // tática. Ela veta lances que perdem à força (corredor que a rival fecha,
    // cabeça com cabeça inevitável); entre os que sobram, decide a heurística.
    let k = -1;
    let perto = Infinity;
    tab.opps.forEach((o, i) => {
      const dd = tab.manhattan(o.head, tab.myBody[0]);
      if (dd < perto) {
        perto = dd;
        k = i;
      }
    });
    if (k >= 0 && perto <= 6) {
      const busca = buscaManoAMano(tab, notas, k);
      if (busca) {
        const faixa = (v) => (v >= VITORIA / 2 ? 2 : v > EMPATE / 2 ? 1 : 0);
        escolhido = 0;
        for (let d = 1; d < 4; d++) {
          const fd = faixa(busca[d]);
          const fe = faixa(busca[escolhido]);
          if (fd > fe || (fd === fe && notas[d] > notas[escolhido])) escolhido = d;
        }
      }
    }
  }

  if (process.env.DEBUG === "true") {
    const resumo = MOVES.map((m, d) => `${m}=${Math.round(notas[d])}`).join(" ");
    console.log(`MOVE ${gameState.turn}: ${MOVES[escolhido]} | ${resumo} | ${Math.round(performance.now() - inicio)}ms`);
  }
  return { move: MOVES[escolhido] };
}