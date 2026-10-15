import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const db = new PrismaClient();
async function seed() {
  const teacher = await db.teacher.upsert({ where: { email: 'demo@classpulse.local' }, update: {}, create: { email: 'demo@classpulse.local', name: 'Giáo viên Demo', passwordHash: await hash(process.env.DEMO_PASSWORD ?? 'Demo@12345', 12) } });
  let quiz = await db.quiz.findFirst({ where: { teacherId: teacher.id, title: 'Khám phá thế giới công nghệ', deletedAt: null }, include: { questions: true } });
  if (!quiz) quiz = await db.quiz.create({ data: { teacherId: teacher.id, title: 'Khám phá thế giới công nghệ', description: '5 câu hỏi khởi động về công nghệ, IoT và thế giới quanh ta.', questions: { create: [
    { content: 'IoT là viết tắt của cụm từ nào?', optionA: 'Internet of Things', optionB: 'Input of Technology', optionC: 'Interface of Tools', optionD: 'Internet of Teams', correctAnswer: 'A', difficulty: 'EASY', knowledge: 'Khái niệm IoT', explanation: 'IoT (Internet of Things) là mạng lưới các thiết bị kết nối Internet để thu thập và trao đổi dữ liệu.', durationSeconds: 30, order: 0 },
    { content: 'ESP32 có thể kết nối Internet thông qua công nghệ nào?', optionA: 'Hồng ngoại', optionB: 'Wi-Fi', optionC: 'NFC', optionD: 'Cáp HDMI', correctAnswer: 'B', difficulty: 'EASY', knowledge: 'Kết nối không dây của ESP32', durationSeconds: 30, order: 1 },
    { content: 'MQTT sử dụng mô hình truyền tin nào?', optionA: 'Chỉ gửi một chiều', optionB: 'Chia sẻ file', optionC: 'Publish / Subscribe', optionD: 'Gọi điện trực tiếp', correctAnswer: 'C', difficulty: 'MEDIUM', knowledge: 'Mô hình publish/subscribe', explanation: 'Thiết bị publish lên broker; các client subscribe topic để nhận tin.', durationSeconds: 30, order: 2 },
    { content: 'Hai LED 7 đoạn hiển thị đồng thời tối đa bao nhiêu ký tự?', optionA: '16', optionB: '8', optionC: '4', optionD: '2', correctAnswer: 'D', difficulty: 'EASY', durationSeconds: 25, order: 3 },
    { content: 'Khi MQTT QoS 1 gửi trùng message, backend nhận biết bằng trường nào?', optionA: 'requestId', optionB: 'optionA', optionC: 'studentName', optionD: 'screenSize', correctAnswer: 'A', difficulty: 'HARD', knowledge: 'Idempotency với QoS 1', durationSeconds: 30, order: 4 },
    { content: 'ESP32 tích hợp sẵn những chuẩn không dây nào? Chọn tất cả các đáp án đúng.', optionA: 'Wi-Fi', optionB: 'Bluetooth Low Energy', optionC: '5G', optionD: 'LoRa', type: 'MULTIPLE', correctAnswer: 'AB', difficulty: 'MEDIUM', knowledge: 'Kết nối không dây của ESP32', explanation: 'ESP32 có sẵn Wi-Fi và Bluetooth (Classic/BLE); 5G và LoRa cần module rời.', durationSeconds: 40, order: 5 },
  ] } }, include: { questions: true } });
  const room = await db.quizSession.findFirst({ where: { roomCode: '123456', status: { not: 'FINISHED' } } });
  if (!room) await db.quizSession.create({ data: { teacherId: teacher.id, quizId: quiz.id, title: quiz.title, roomCode: '123456', mode: 'MANUAL', questions: { create: quiz.questions.map(q => ({ sourceQuestionId: q.id, content: q.content, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD,
    type: q.type, correctAnswer: q.correctAnswer, explanation: q.explanation, knowledge: q.knowledge, topic: q.topic, difficulty: q.difficulty, durationSeconds: q.durationSeconds, order: q.order })) } } });
  if (!await db.classroom.findFirst({ where: { teacherId: teacher.id, name: 'Lớp demo' } })) await db.classroom.create({ data: { teacherId: teacher.id, name: 'Lớp demo', description: 'Danh sách mẫu: sinh viên nhập mã 01–03 trên thiết bị.',
    students: { create: [{ code: '01', name: 'Nguyễn Minh An' }, { code: '02', name: 'Trần Thu Bình' }, { code: '03', name: 'Lê Hoàng Chi' }] } } });
  console.log('Seed ready: demo@classpulse.local / room 123456. Password comes from DEMO_PASSWORD or documented development default.');
}
void seed().finally(() => db.$disconnect());
