import golden from './assets/fantasy-golden.png'
import moon from './assets/fantasy-moon.png'
import storm from './assets/fantasy-storm.png'
import rain from './assets/city-rain.png'
import sunset from './assets/western-sunset.png'
import autumn from './assets/samurai-autumn.png'
import cavern from './assets/cavern-blue.png'
import planet from './assets/planet-dawn.png'

// 生成的 UI 示例；不代表用户的 Steam 数据。
export interface PreviewGame {
  id: string
  name: string
  english: string
  genre: string
  cover: string
}
export interface PreviewShot {
  id: string
  gameId: string
  title: string
  src: string
  date: string
  filename: string
}
export const games: PreviewGame[] = [
  {
    id: 'elden',
    name: '艾尔登法环',
    english: 'ELDEN RING',
    genre: '角色扮演',
    cover: golden,
  },
  {
    id: 'cyber',
    name: '赛博朋克 2077',
    english: 'CYBERPUNK 2077',
    genre: '角色扮演',
    cover: rain,
  },
  {
    id: 'red',
    name: '荒野大镖客 2',
    english: 'RED DEAD REDEMPTION 2',
    genre: '开放世界',
    cover: sunset,
  },
  {
    id: 'sekiro',
    name: '只狼：影逝二度',
    english: 'SEKIRO: SHADOWS DIE TWICE',
    genre: '动作冒险',
    cover: autumn,
  },
  {
    id: 'hollow',
    name: '空洞骑士',
    english: 'HOLLOW KNIGHT',
    genre: '动作冒险',
    cover: cavern,
  },
  {
    id: 'space',
    name: '无人深空',
    english: 'NO MAN’S SKY',
    genre: '开放世界',
    cover: planet,
  },
]
export const shots: PreviewShot[] = [
  {
    id: '1',
    gameId: 'elden',
    title: '黄金树下',
    src: golden,
    date: '2026-09-20 18:42',
    filename: '20260920184201.jpg',
  },
  {
    id: '2',
    gameId: 'elden',
    title: '月色与湖泊',
    src: moon,
    date: '2026-09-20 18:28',
    filename: '20260920182804.jpg',
  },
  {
    id: '3',
    gameId: 'elden',
    title: '风暴将至',
    src: storm,
    date: '2026-09-19 21:16',
    filename: '20260919211608.jpg',
  },
  ...games
    .slice(1)
    .map((game, index) => ({
      id: String(index + 4),
      gameId: game.id,
      title: ['雨夜漫游', '落日归途', '山寺秋意', '幽蓝深处', '另一个黎明'][
        index
      ]!,
      src: game.cover,
      date: `2026-09-${18 - index} 19:32`,
      filename: `202609${18 - index}193200.jpg`,
    })),
]
export const shotsFor = (gameId: string) =>
  shots.filter((shot) => shot.gameId === gameId)
export const gameFor = (shot: PreviewShot) =>
  games.find((game) => game.id === shot.gameId)!
