import { WorldScene } from "@/components/WorldScene";
import { defaultWorldId, worlds } from "@/worlds/worlds";

export default function Home() {
  return <WorldScene worlds={worlds} initialWorldId={defaultWorldId} />;
}
